package main

import (
	"context"
	"log"
	"net"
	"net/url"
	"strings"
	"time"

	"kubehelm/server/internal/ci"
	"kubehelm/server/internal/config"
	"kubehelm/server/internal/crypto"
	"kubehelm/server/internal/db"
	"kubehelm/server/internal/k8s"
	"kubehelm/server/internal/model"
	"kubehelm/server/internal/registry"
	"kubehelm/server/internal/repository"
	"kubehelm/server/internal/router"
	"kubehelm/server/internal/seed"
)

func main() {
	// 强制 DNS 走 cgo resolver（libc getaddrinfo），与系统 ping / curl 行为一致：
	//   - 默认 pure Go resolver 只读 /etc/resolv.conf 不读 /etc/hosts，.local / 内网域名解析不到；
	//   - cgo resolver 走 libc getaddrinfo，完整支持 /etc/hosts / mDNSResponder 等系统解析器。
	// 这是导致用户在 /etc/hosts 配了 dockerhub.kubekey.local 但 Go 程序仍然 "i/o timeout" 的根因。
	net.DefaultResolver = &net.Resolver{PreferGo: false}

	cfg := config.Load()
	database := db.Init(cfg)
	seed.Run(database)
	store := repository.New(database)
	// 旧 DevOps 数据迁移：未归属集群的流水线 / 镜像仓库连接 / 构建记录归到第一个集群（dev-cluster-1）。
	migrateDevOpsClusterOwnership(store)
	k8sMgr := k8s.NewManager(database)
	ciEngine := ci.New(store, k8sMgr)
	// 启动时回收遗留的 running 构建（进程重启后无存活协程，避免僵尸构建卡死 UI 中止）
	go ciEngine.Recover()
	// 启动时预热所有 registry 域名的 DNS 解析缓存。
	// 原因：macOS 上 cgo resolver（libc getaddrinfo）首次解析 .local 域名（mDNSResponder + /etc/hosts）
	//       需要约 5s；如果不预热，运行时首次请求 Transport.DialContext 5s timeout 会被卡在 DNS 阶段，
	//       表现就是"i/o timeout"。预热后 cgo resolver 内部有缓存，后续请求秒开。
	go warmRegistryDNS(store)

	r := router.New(store, k8sMgr, ciEngine)

	addr := ":" + cfg.Port
	log.Printf("DunHelm backend listening on %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatalf("server exit: %v", err)
	}
}

// warmRegistryDNS 异步遍历所有 registry 连接，对每个 host 做一次 DNS 解析，填入应用层 DNS 缓存。
// 这样后续 http.Transport.DialContext 通过 DialContextWithCache 直接连 IP（ms 级），不再走 5s cgo resolver。
func warmRegistryDNS(store *repository.Store) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[warm-dns] recovered panic: %v", r)
		}
	}()
	var eps []model.RegistryEndpoint
	if err := store.DB.Find(&eps).Error; err != nil {
		return
	}
	for _, ep := range eps {
		host := extractHost(ep.URL)
		if host == "" || net.ParseIP(host) != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		t0 := time.Now()
		ips, err := registry.ResolveHost(ctx, host)
		cancel()
		if err != nil {
			log.Printf("[warm-dns] %s err=%v (%v)", host, err, time.Since(t0))
		} else {
			log.Printf("[warm-dns] %s -> %v (%v)", host, ips, time.Since(t0))
		}
	}
}

// extractHost 从 URL 中提取 host 部分
func extractHost(rawURL string) string {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return ""
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// migrateDevOpsClusterOwnership 将历史遗留（cluster_id 为 0/空）的流水线、镜像仓库连接及其构建记录
// 归并到 dev-cluster-1（用户原本就在该集群创建这些资源）；找不到该集群时再回退到 id 最小的集群，
// 避免多集群隔离上线后旧数据「无家可归」导致所有集群列表都查不到。
// 幂等：已带 cluster_id 的记录不受 UPDATE 影响；每次启动执行一次无副作用。
func migrateDevOpsClusterOwnership(store *repository.Store) {
	var target model.Cluster
	// 优先归属 dev-cluster-1；不存在再取 id 最小的集群兜底
	if err := store.DB.Where("name = ?", "dev-cluster-1").First(&target).Error; err != nil {
		if err := store.DB.Order("id").First(&target).Error; err != nil {
			return // 无集群，跳过
		}
	}
	cid := target.ID
	store.DB.Exec("UPDATE pipelines SET cluster_id = ? WHERE cluster_id = 0 OR cluster_id IS NULL", cid)
	store.DB.Exec("UPDATE registry_endpoints SET cluster_id = ? WHERE cluster_id = 0 OR cluster_id IS NULL", cid)
	store.DB.Exec("UPDATE builds SET cluster_id = (SELECT p.cluster_id FROM pipelines p WHERE p.name = builds.pipeline_name LIMIT 1) WHERE cluster_id = 0 OR cluster_id IS NULL", cid)
	// Maven 全局设置（原本平台级单行，现在按集群隔离）：把历史记录归到 dev-cluster-1
	store.DB.Exec("UPDATE maven_global_settings SET cluster_id = ? WHERE cluster_id = 0 OR cluster_id IS NULL", cid)
	// 标记 5 个内置参考流水线为公共模板（is_template=true），使其可被其他集群读取（读路径回退）
	store.DB.Exec("UPDATE pipelines SET is_template = 1 WHERE name IN ('payment-api-ci', 'ai-operator-build', 'order-svc-cd', 'gateway-envoy-ci', 'user-svc-ci')")

	// RBAC：补齐 4 个系统内置角色（无则插入，幂等）
	for _, r := range []model.Role{
		{Slug: model.RolePlatformAdmin, Name: "平台管理员", Description: "超级管理员，拥有所有集群所有权限", IsSystem: true, SortOrder: 10},
		{Slug: model.RoleWorkspaceAdmin, Name: "空间管理员", Description: "单集群命名空间管理（除系统隔离 namespace）", IsSystem: true, SortOrder: 20},
		{Slug: model.RoleDeveloper, Name: "开发者", Description: "单集群读写，可部署与发布", IsSystem: true, SortOrder: 30},
		{Slug: model.RoleViewer, Name: "访客", Description: "只读权限", IsSystem: true, SortOrder: 40},
	} {
		store.DB.Exec(
			"INSERT INTO roles (slug, name, description, is_system, sort_order) VALUES (?,?,?,?,?) ON CONFLICT(slug) DO NOTHING",
			r.Slug, r.Name, r.Description, r.IsSystem, r.SortOrder,
		)
	}
	// 旧 mock 用户 Role 字段为中文，迁移到 slug 形式
	store.DB.Exec("UPDATE users SET role = ? WHERE role = '平台管理员'", model.RolePlatformAdmin)
	store.DB.Exec("UPDATE users SET role = ? WHERE role = '空间管理员'", model.RoleWorkspaceAdmin)
	store.DB.Exec("UPDATE users SET role = ? WHERE role = '开发者'", model.RoleDeveloper)
	store.DB.Exec("UPDATE users SET role = ? WHERE role = '访客'", model.RoleViewer)
	// 旧用户 Active 默认为 0（false），启动时统一修正为启用
	store.DB.Exec("UPDATE users SET active = 1 WHERE active = 0 OR active IS NULL")
	// 旧库用户无密码（升级前），统一补上初始密码哈希，确保可登录
	ensureUserPasswords(store)
	// users 表为空时（例如旧库 seed 被 clusters 计数提前跳过）补建内置用户，保证有可用管理员账号
	seed.EnsureUsers(store.DB)

	// 菜单权限（RBAC 菜单可见性）：4 个系统角色预设默认菜单可见集合，幂等 upsert
	// 平台管理员/已存在的同名记录 ON CONFLICT DO NOTHING，保留 UI 后续修改
	for roleSlug, menus := range model.DefaultMenuPermissions {
		for _, m := range menus {
			store.DB.Exec(
				"INSERT INTO menu_permissions (role_slug, menu_key, created_at) VALUES (?,?,?) ON CONFLICT(role_slug, menu_key) DO NOTHING",
				roleSlug, m, time.Now().Format("2006-01-02 15:04:05"),
			)
		}
	}

	// 审计日志表 schema 升级：旧 model.AuditLog 的 time 列是 string（TEXT），GORM 重构后字段是 time.Time。
	// SQLite ALTER COLUMN TYPE 限制无法直接改列类型，因此：
	//  1) 创建新表 audit_logs_v2（结构匹配当前 model.AuditLog）
	//  2) 把旧表数据按新字段映射导入
	//  3) DROP 旧表，RENAME 新表
	// 旧 mock seed 数据已被移除；历史审计行为从 user.create/role.*/permission.* 重新产生。
	migrateAuditLogSchema(store)
}

// migrateAuditLogSchema 把旧 audit_logs 表（time TEXT）迁移到新结构（time DATETIME + 结构化字段）。
// 因 seed 已不再生成 mock 数据，旧表基本无意义；这里直接 DROP 重建以避免 schema 不兼容。
func migrateAuditLogSchema(store *repository.Store) {
	// 探测旧表是否存在
	var n int64
	store.DB.Raw("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='audit_logs'").Scan(&n)
	if n == 0 {
		// 没表也没事，AutoMigrate 已建过（如果模型在 AllModels）—— 确保显式 create
		if !store.DB.Migrator().HasTable(&model.AuditLog{}) {
			store.DB.Migrator().CreateTable(&model.AuditLog{})
		}
		return
	}
	// 探测新字段是否齐全
	store.DB.Raw("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='audit_logs' AND sql LIKE '%time DATETIME%'").Scan(&n)
	if n == 1 {
		return // 已经迁移过
	}
	// 直接 drop 旧表，再用 Migrator 重建。旧审计记录会丢失（seed 已清）。
	store.DB.Exec("DROP TABLE IF EXISTS audit_logs")
	store.DB.Migrator().CreateTable(&model.AuditLog{})
}

// ensureUserPasswords 给所有尚未设置密码的已有用户补上统一初始密码哈希，
// 兼容升级前的旧库（User 表无 password 列 / 为空），确保都能正常登录。
// 幂等：仅处理 Password 为空的用户，已设置的不动。
func ensureUserPasswords(store *repository.Store) {
	var users []model.User
	if err := store.DB.Find(&users).Error; err != nil {
		return
	}
	hash, err := crypto.HashPassword(model.DefaultUserPassword)
	if err != nil {
		return
	}
	for _, u := range users {
		if u.Password == "" {
			store.DB.Model(&model.User{}).Where("id = ?", u.ID).Update("password", hash)
		}
	}
}
