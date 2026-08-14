package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const (
	maxItems       = 1000
	cookieName     = "shortcut_session"
	defaultPort    = "8080"
	iconMaxAge     = 30 * 24 * time.Hour
	maxIconBytes   = 256 * 1024
	databaseRetries = 30
)

type item struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	UpdatedAt string `json:"updatedAt"`
}

type state struct {
	Revision  int    `json:"revision"`
	UpdatedAt string `json:"updatedAt"`
	Items     []item `json:"items"`
}

type updateRequest struct {
	BaseRevision int    `json:"baseRevision"`
	Items        []item `json:"items"`
}

type server struct {
	root          string
	db            *sql.DB
	password      string
	sessionSecret []byte
	sessionDays   int
	mu            sync.Mutex
}

func main() {
	root, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}

	password := strings.TrimSpace(os.Getenv("APP_PASSWORD"))
	if password == "" {
		log.Fatal("APP_PASSWORD is required")
	}
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required, for example postgres://navi_db:password@1Panel-postgresql-V7UN:5432/navi_db?sslmode=disable")
	}
	secret := os.Getenv("SESSION_SECRET")
	if secret == "" {
		secret = password
	}
	sessionDays, err := sessionDaysFromEnv()
	if err != nil {
		log.Fatal(err)
	}

	db, err := openDatabase(databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := initSchema(db); err != nil {
		log.Fatalf("initialize PostgreSQL schema failed: %v", err)
	}
	if err := migrateLegacyJSON(db, filepath.Join(root, "shortcuts.json")); err != nil {
		log.Fatalf("migrate shortcuts.json failed: %v", err)
	}

	s := &server{
		root:          root,
		db:            db,
		password:      password,
		sessionSecret: []byte(secret),
		sessionDays:   sessionDays,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api", s.apiHandler)
	mux.HandleFunc("/api.php", s.apiHandler) // 兼容旧前端地址
	mux.HandleFunc("/healthz", s.healthz)
	mux.HandleFunc("/", s.staticHandler)

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}
	addr := ":" + strings.TrimPrefix(port, ":")
	log.Printf("site navigation listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, logging(mux)))
}

func openDatabase(databaseURL string) (*sql.DB, error) {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)

	var lastErr error
	for attempt := 1; attempt <= databaseRetries; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = db.PingContext(ctx)
		cancel()
		if err == nil {
			return db, nil
		}
		lastErr = err
		log.Printf("PostgreSQL connection attempt %d/%d failed: %v", attempt, databaseRetries, err)
		time.Sleep(2 * time.Second)
	}
	db.Close()
	return nil, fmt.Errorf("PostgreSQL connection failed after %d attempts: %w", databaseRetries, lastErr)
}

func sessionDaysFromEnv() (int, error) {
	value := strings.TrimSpace(os.Getenv("SESSION_DAYS"))
	if value == "" {
		return 7, nil
	}
	days, err := strconv.Atoi(value)
	if err != nil || days < 1 || days > 3650 {
		return 0, fmt.Errorf("SESSION_DAYS must be an integer from 1 to 3650")
	}
	return days, nil
}

func initSchema(db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS navi_meta (
			id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
			revision BIGINT NOT NULL DEFAULT 0,
			updated_at TIMESTAMPTZ NULL
		)`,
		`CREATE TABLE IF NOT EXISTS navi_shortcuts (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			url TEXT NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL,
			"position" INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS navi_icons (
			item_id TEXT PRIMARY KEY REFERENCES navi_shortcuts(id) ON DELETE CASCADE,
			content_type TEXT NOT NULL,
			body BYTEA NOT NULL,
			source_url TEXT NOT NULL,
			fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`INSERT INTO navi_meta (id, revision) VALUES (TRUE, 0) ON CONFLICT (id) DO NOTHING`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

func migrateLegacyJSON(db *sql.DB, filename string) error {
	data, err := os.ReadFile(filename)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var legacy state
	if err := json.Unmarshal(data, &legacy); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if len(legacy.Items) == 0 {
		return nil
	}
	clean, err := cleanItems(legacy.Items)
	if err != nil {
		return err
	}
	if len(clean) == 0 {
		return nil
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var count int
	var revision int64
	if err := tx.QueryRow(`SELECT COUNT(*), revision FROM navi_shortcuts CROSS JOIN navi_meta WHERE navi_meta.id = TRUE`).Scan(&count, &revision); err != nil {
		return err
	}
	if count != 0 || revision != 0 {
		return tx.Commit()
	}
	updatedAt := parseTimeOrNow(legacy.UpdatedAt)
	for position, entry := range clean {
		if _, err := tx.Exec(`
			INSERT INTO navi_shortcuts (id, title, url, updated_at, "position")
			VALUES ($1, $2, $3, $4, $5)
		`, entry.ID, entry.Title, entry.URL, parseTimeOrNow(entry.UpdatedAt), position); err != nil {
			return err
		}
	}
	if legacy.Revision < 1 {
		legacy.Revision = 1
	}
	if _, err := tx.Exec(`UPDATE navi_meta SET revision = $1, updated_at = $2 WHERE id = TRUE`, legacy.Revision, updatedAt); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("migrated %d shortcut(s) from shortcuts.json to PostgreSQL", len(clean))
	return nil
}

func (s *server) apiHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.URL.Query().Get("action") == "login" && r.Method == http.MethodPost {
		s.login(w, r)
		return
	}
	if !s.validSession(r) {
		jsonError(w, "需要登录。", http.StatusUnauthorized)
		return
	}
	if r.URL.Query().Get("action") == "icon" && r.Method == http.MethodGet {
		s.icon(w, r)
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.read(w, r)
	case http.MethodPut:
		s.update(w, r)
	default:
		jsonError(w, "只支持 GET 和 PUT。", http.StatusMethodNotAllowed)
	}
}

func (s *server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.db.PingContext(ctx); err != nil {
		jsonError(w, "PostgreSQL 不可用。", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *server) icon(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		http.NotFound(w, r)
		return
	}

	var target string
	var cachedBody []byte
	var cachedType sql.NullString
	var fetchedAt sql.NullTime
	err := s.db.QueryRowContext(r.Context(), `
		SELECT s.url, i.content_type, i.body, i.fetched_at
		FROM navi_shortcuts s
		LEFT JOIN navi_icons i ON i.item_id = s.id
		WHERE s.id = $1
	`, id).Scan(&target, &cachedType, &cachedBody, &fetchedAt)
	if errors.Is(err, sql.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		jsonError(w, "读取图标缓存失败。", http.StatusInternalServerError)
		return
	}
	if len(cachedBody) > 0 && cachedType.Valid && fetchedAt.Valid && time.Since(fetchedAt.Time) < iconMaxAge {
		writeIcon(w, cachedType.String, cachedBody)
		return
	}

	parsed, err := url.Parse(target)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		http.NotFound(w, r)
		return
	}
	iconURL := parsed.Scheme + "://" + parsed.Host + "/favicon.ico"
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(iconURL)
	if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		if response != nil {
			response.Body.Close()
		}
		http.NotFound(w, r)
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxIconBytes+1))
	if err != nil || len(body) == 0 || len(body) > maxIconBytes {
		http.NotFound(w, r)
		return
	}
	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = http.DetectContentType(body)
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		contentType = http.DetectContentType(body)
	}
	_, _ = s.db.ExecContext(r.Context(), `
		INSERT INTO navi_icons (item_id, content_type, body, source_url, fetched_at)
		VALUES ($1, $2, $3, $4, NOW())
		ON CONFLICT (item_id) DO UPDATE SET content_type = EXCLUDED.content_type, body = EXCLUDED.body, source_url = EXCLUDED.source_url, fetched_at = EXCLUDED.fetched_at
	`, id, contentType, body, iconURL)
	writeIcon(w, contentType, body)
}

func writeIcon(w http.ResponseWriter, contentType string, body []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(body)
}

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Password string `json:"password"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input) != nil || subtle.ConstantTimeCompare([]byte(input.Password), []byte(s.password)) != 1 {
		jsonError(w, "密码不正确。", http.StatusUnauthorized)
		return
	}

	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    s.makeSession(),
		Path:     "/",
		MaxAge:   s.sessionDays * 24 * 60 * 60,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, map[string]any{"ok": true})
}

func (s *server) makeSession() string {
	expires := strconv.FormatInt(time.Now().Add(time.Duration(s.sessionDays)*24*time.Hour).Unix(), 10)
	sig := hmac.New(sha256.New, s.sessionSecret)
	_, _ = sig.Write([]byte(expires))
	return base64.RawURLEncoding.EncodeToString([]byte(expires)) + "." + base64.RawURLEncoding.EncodeToString(sig.Sum(nil))
}

func (s *server) validSession(r *http.Request) bool {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return false
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return false
	}
	expiresBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	expires, err := strconv.ParseInt(string(expiresBytes), 10, 64)
	if err != nil || expires <= time.Now().Unix() {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	h := hmac.New(sha256.New, s.sessionSecret)
	_, _ = h.Write(expiresBytes)
	return hmac.Equal(sig, h.Sum(nil))
}

func (s *server) read(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.loadState(r.Context())
	if err != nil {
		jsonError(w, "读取 PostgreSQL 数据失败。", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "revision": current.Revision, "updatedAt": current.UpdatedAt, "items": current.Items})
}

func (s *server) update(w http.ResponseWriter, r *http.Request) {
	var input updateRequest
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&input) != nil {
		jsonError(w, "请求格式不正确。", http.StatusBadRequest)
		return
	}

	clean, err := cleanItems(input.Items)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next, conflict, err := s.updateState(r.Context(), input.BaseRevision, clean)
	if err != nil {
		jsonError(w, "保存 PostgreSQL 数据失败。", http.StatusInternalServerError)
		return
	}
	if conflict {
		writeJSONStatus(w, map[string]any{"ok": false, "message": "其他设备已有更新。", "state": next}, http.StatusConflict)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "revision": next.Revision, "updatedAt": next.UpdatedAt, "items": next.Items})
}

func cleanItems(items []item) ([]item, error) {
	if len(items) > maxItems {
		items = items[:maxItems]
	}
	clean := make([]item, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, entry := range items {
		entry.ID = strings.TrimSpace(entry.ID)
		entry.Title = strings.TrimSpace(entry.Title)
		entry.URL = strings.TrimSpace(entry.URL)
		if entry.ID == "" || entry.Title == "" || entry.URL == "" {
			continue
		}
		if len(entry.ID) > 100 {
			entry.ID = entry.ID[:100]
		}
		if _, exists := seen[entry.ID]; exists {
			continue
		}
		seen[entry.ID] = struct{}{}
		parsed, err := url.Parse(entry.URL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return nil, fmt.Errorf("网址格式不正确：%s", entry.URL)
		}
		if len([]rune(entry.Title)) > 80 {
			entry.Title = string([]rune(entry.Title)[:80])
		}
		if len(entry.URL) > 2000 {
			entry.URL = entry.URL[:2000]
		}
		if entry.UpdatedAt == "" {
			entry.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		}
		clean = append(clean, entry)
	}
	return clean, nil
}

func (s *server) loadState(ctx context.Context) (state, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return state{}, err
	}
	defer tx.Rollback()
	current, err := readStateTx(ctx, tx)
	if err != nil {
		return state{}, err
	}
	if err := tx.Commit(); err != nil {
		return state{}, err
	}
	return current, nil
}

func readStateTx(ctx context.Context, tx *sql.Tx) (state, error) {
	var revision int64
	var updatedAt sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT revision, updated_at FROM navi_meta WHERE id = TRUE`).Scan(&revision, &updatedAt); err != nil {
		return state{}, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, title, url, updated_at FROM navi_shortcuts ORDER BY "position", id`)
	if err != nil {
		return state{}, err
	}
	defer rows.Close()
	items := make([]item, 0)
	for rows.Next() {
		var entry item
		var entryUpdated time.Time
		if err := rows.Scan(&entry.ID, &entry.Title, &entry.URL, &entryUpdated); err != nil {
			return state{}, err
		}
		entry.UpdatedAt = formatTime(entryUpdated)
		items = append(items, entry)
	}
	if err := rows.Err(); err != nil {
		return state{}, err
	}
	return state{Revision: int(revision), UpdatedAt: formatNullTime(updatedAt), Items: items}, nil
}

func (s *server) updateState(ctx context.Context, baseRevision int, items []item) (state, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return state{}, false, err
	}
	defer tx.Rollback()

	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM navi_meta WHERE id = TRUE FOR UPDATE`).Scan(&revision); err != nil {
		return state{}, false, err
	}
	if int(revision) != baseRevision {
		current, err := readStateTx(ctx, tx)
		return current, true, err
	}

	existing := make(map[string]string)
	rows, err := tx.QueryContext(ctx, `SELECT id, url FROM navi_shortcuts`)
	if err != nil {
		return state{}, false, err
	}
	for rows.Next() {
		var id, existingURL string
		if err := rows.Scan(&id, &existingURL); err != nil {
			rows.Close()
			return state{}, false, err
		}
		existing[id] = existingURL
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return state{}, false, err
	}
	rows.Close()

	seen := make(map[string]struct{}, len(items))
	for position, entry := range items {
		seen[entry.ID] = struct{}{}
		if oldURL, ok := existing[entry.ID]; ok && oldURL != entry.URL {
			if _, err := tx.ExecContext(ctx, `DELETE FROM navi_icons WHERE item_id = $1`, entry.ID); err != nil {
				return state{}, false, err
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO navi_shortcuts (id, title, url, updated_at, "position")
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, updated_at = EXCLUDED.updated_at, "position" = EXCLUDED."position"
		`, entry.ID, entry.Title, entry.URL, parseTimeOrNow(entry.UpdatedAt), position); err != nil {
			return state{}, false, err
		}
	}
	for id := range existing {
		if _, ok := seen[id]; !ok {
			if _, err := tx.ExecContext(ctx, `DELETE FROM navi_shortcuts WHERE id = $1`, id); err != nil {
				return state{}, false, err
			}
		}
	}

	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `UPDATE navi_meta SET revision = revision + 1, updated_at = $1 WHERE id = TRUE`, now); err != nil {
		return state{}, false, err
	}
	next, err := readStateTx(ctx, tx)
	if err != nil {
		return state{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return state{}, false, err
	}
	return next, false, nil
}

func parseTimeOrNow(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Now().UTC()
	}
	return parsed.UTC()
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}

func formatNullTime(value sql.NullTime) string {
	if !value.Valid {
		return ""
	}
	return formatTime(value.Time)
}

func (s *server) staticHandler(w http.ResponseWriter, r *http.Request) {
	cleanPath := filepath.Clean("/" + r.URL.Path)
	switch cleanPath {
	case "/shortcuts.json", "/config.php", "/main.go", "/go.mod", "/go.sum", "/schema.sql", "/start.sh":
		http.NotFound(w, r)
		return
	}
	if strings.HasPrefix(cleanPath, "/.git") || strings.HasSuffix(cleanPath, ".tmp") {
		http.NotFound(w, r)
		return
	}
	if cleanPath == "/" {
		cleanPath = "/index.html"
	}
	file := filepath.Join(s.root, filepath.FromSlash(strings.TrimPrefix(cleanPath, "/")))
	if !strings.HasPrefix(file, s.root+string(os.PathSeparator)) {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, file)
}

func writeJSON(w http.ResponseWriter, value any) { writeJSONStatus(w, value, http.StatusOK) }

func writeJSONStatus(w http.ResponseWriter, value any, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func jsonError(w http.ResponseWriter, message string, status int) {
	writeJSONStatus(w, map[string]any{"ok": false, "message": message}, status)
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(started).Round(time.Millisecond))
	})
}
