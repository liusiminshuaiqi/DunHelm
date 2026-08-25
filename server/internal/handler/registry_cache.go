package handler

import (
	"sync"
	"time"
)

// registryCache 镜像仓库读路径的短期 TTL 缓存。
//
// 背景：ImagePicker 打开后会依次拉 项目 → 仓库 → 制品 三个列表，每次都重新建 HarborClient / DockerHub Client，
// 都走 DNS + TCP + TLS 握手 + 真实仓库接口（域名为 dockerhub.kubekey.local 时跨网络会秒级延迟）。
// 项目/仓库列表变更极慢（手工操作），用 30s TTL 内存缓存让"几秒"变"毫秒"。
//
// 失效时机：
//   - RegistryCreateProject / RegistryUpdateProject / RegistryDeleteProject：清掉 reg/proj/repo 三层所有缓存
//   - RegistryPushImage（暂无）/ 用户在 Harbor Web UI 操作：不失效，靠 TTL 自然过期（最长 30s 看到）
//
// key 形如：reg/<id>/projects、reg/<id>/projects/<proj>/repos、reg/<id>/projects/<proj>/repos/<repo>/artifacts
type registryCache struct {
	mu   sync.RWMutex
	data map[string]registryCacheEntry
	ttl  time.Duration
}

type registryCacheEntry struct {
	body []byte
	ts   time.Time
}

func newRegistryCache(ttl time.Duration) *registryCache {
	return &registryCache{data: make(map[string]registryCacheEntry), ttl: ttl}
}

// get 命中且未过期返回缓存内容；否则返回 ok=false。
func (c *registryCache) get(key string) ([]byte, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.RLock()
	e, ok := c.data[key]
	c.mu.RUnlock()
	if !ok || time.Since(e.ts) > c.ttl {
		return nil, false
	}
	return e.body, true
}

func (c *registryCache) set(key string, body []byte) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.data[key] = registryCacheEntry{body: body, ts: time.Now()}
	c.mu.Unlock()
}

// invalidatePrefix 清掉所有以 prefix 开头的缓存条目。例如 invalidatePrefix("reg/7/") 会清掉某个连接的所有缓存。
func (c *registryCache) invalidatePrefix(prefix string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	for k := range c.data {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			delete(c.data, k)
		}
	}
	c.mu.Unlock()
}

// keyProjects / keyRepos / keyArtifacts 拼缓存 key（按 registry id 维度隔离）。
func keyProjects(registryID uint) string {
	return keyPrefix(registryID) + "/projects"
}
func keyRepos(registryID uint, project string) string {
	return keyPrefix(registryID) + "/projects/" + project + "/repos"
}
func keyArtifacts(registryID uint, project, repo string) string {
	return keyPrefix(registryID) + "/projects/" + project + "/repos/" + repo + "/artifacts"
}
func keyPrefix(registryID uint) string {
	return "reg/" + uintToStr(registryID)
}

// uintToStr 简单整数到字符串，避免 strconv 在热点路径上分配（缓存 key 拼装会频繁调用）。
func uintToStr(n uint) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}