package registry

import (
	"context"
	"net"
	"sync"
	"time"
)

// dnsCache 应用层 DNS 解析缓存。
//
// 背景：macOS 上 cgo resolver（libc getaddrinfo）首次解析 .local / 内网域名要走 mDNSResponder，
// 每次都要约 5s。http.Transport.DialContext 默认 5s timeout 会被卡在 DNS 阶段，
// 表现就是"i/o timeout"。
//
// 这里在应用层维护 host → []IP 的缓存，配合 custom DialContext：
//   - 命中 → 直接 dial 缓存的 IP（绕过系统 DNS，慢速 mDNSResponder 也无关）
//   - 未命中 → 走一次 LookupHost（容忍 8s），缓存结果 5min，再连
//
// 这样首次请求付一次 5s 代价（已通过 main.go 的 warmRegistryDNS 在启动期承担），
// 后续请求都是 ms 级。
type dnsCache struct {
	mu    sync.RWMutex
	entry map[string]dnsCacheEntry
}

type dnsCacheEntry struct {
	addrs []net.IP
	ts    time.Time
	err   string // 上次解析的错误（用于 30s 内不再重试，避免一直重复 5s 等）
	errTs  time.Time
}

const (
	dnsCacheOKTTL = 5 * time.Minute
	dnsCacheErrTTL = 30 * time.Second
	dnsLookupTimeout = 8 * time.Second
)

var globalDNSCache = &dnsCache{entry: map[string]dnsCacheEntry{}}

// ResolveHost 暴露给外部（main.go 的 warmRegistryDNS），应用层主动把 host 的解析结果填入缓存。
func ResolveHost(ctx context.Context, host string) ([]net.IP, error) {
	return globalDNSCache.Resolve(ctx, host)
}

// Resolve 通过缓存拿到 host 的 IP 列表。cache miss 时主动 LookupHost（容忍 8s）并写入缓存。
// errTTL 用于避免持续错误导致每个请求都等 5s——失败后 30s 内直接返错。
func (c *dnsCache) Resolve(ctx context.Context, host string) ([]net.IP, error) {
	// IP 字面量：直接返回
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	now := time.Now()

	// 读锁查缓存
	c.mu.RLock()
	if e, ok := c.entry[host]; ok {
		// OK 缓存
		if len(e.addrs) > 0 && now.Sub(e.ts) < dnsCacheOKTTL {
			c.mu.RUnlock()
			return e.addrs, nil
		}
		// ERR 缓存（避免持续重试同一错误）
		if e.err != "" && now.Sub(e.errTs) < dnsCacheErrTTL {
			c.mu.RUnlock()
			return nil, &dnsCachedErr{host: host, err: e.err}
		}
	}
	c.mu.RUnlock()

	// 写锁后再次确认（避免并发重复解析）
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.entry[host]; ok {
		if len(e.addrs) > 0 && now.Sub(e.ts) < dnsCacheOKTTL {
			return e.addrs, nil
		}
		if e.err != "" && now.Sub(e.errTs) < dnsCacheErrTTL {
			return nil, &dnsCachedErr{host: host, err: e.err}
		}
	}

	// cache miss → 真正解析
	lctx, cancel := context.WithTimeout(ctx, dnsLookupTimeout)
	addrs, err := net.DefaultResolver.LookupIPAddr(lctx, host)
	cancel()
	if err != nil {
		c.entry[host] = dnsCacheEntry{err: err.Error(), errTs: now}
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		if ip := a.IP; ip != nil {
			ips = append(ips, ip)
		}
	}
	if len(ips) == 0 {
		c.entry[host] = dnsCacheEntry{err: "no such host", errTs: now}
		return nil, &net.DNSError{Err: "no such host", Name: host}
	}
	c.entry[host] = dnsCacheEntry{addrs: ips, ts: now}
	return ips, nil
}

// Invalidate 主动失效某个 host 的缓存（用于配置变更后强制重解析）
func (c *dnsCache) Invalidate(host string) {
	c.mu.Lock()
	delete(c.entry, host)
	c.mu.Unlock()
}

// dnsCachedErr 用于让上层一眼能看出"该错误已被缓存"（避免误以为是真的网络问题）
type dnsCachedErr struct {
	host string
	err  string
}

func (e *dnsCachedErr) Error() string {
	return e.err
}

// DialContextWithCache 自定义 dial 函数：cache hit → 直接连 IP（ms 级）；miss → 解析 → 缓存 → 再连。
// 端口由 caller 传入（net.JoinHostPort 已经处理好的 ip:port 字符串）。
func DialContextWithCache(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := globalDNSCache.Resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for _, ip := range ips {
		c, dialErr := (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if dialErr == nil {
			return c, nil
		}
		lastErr = dialErr
	}
	if lastErr == nil {
		lastErr = &net.OpError{Op: "dial", Net: network, Err: &net.DNSError{Err: "no usable IP", Name: host}}
	}
	return nil, lastErr
}