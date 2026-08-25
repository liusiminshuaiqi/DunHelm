package model

// MenuPermission 角色对菜单项的可见性。
// 一行 = (role_slug, menu_key)；同一角色同一菜单只允许一条（联合唯一）。
// 平台管理员（platform-admin）通过 middleware bypass，不依赖此表（默认全部菜单可见）。
// 自定义角色创建时无任何记录，UI 需提示"未授权菜单将不可见"。
type MenuPermission struct {
	ID        uint   `gorm:"primarykey" json:"-"`
	RoleSlug  string `gorm:"uniqueIndex:idx_role_menu;index;size:64" json:"roleSlug"`
	MenuKey   string `gorm:"uniqueIndex:idx_role_menu;size:64" json:"menuKey"`
	CreatedAt string `json:"createdAt"`
}

// ALL_MENU_KEYS 全平台菜单项常量（与前端 Sidebar ViewKey + groups  一对齐）
// 修改时同步同步同步：
//   server/internal/handler/menu.go
//   app/src/components/layout/Sidebar.tsx
//   app/src/components/ui/MenuKeys.ts
const (
	MenuOverview    = "overview"
	MenuWorkloads   = "workloads"
	MenuNodes       = "nodes"
	MenuStorage     = "storage"
	MenuNetwork     = "network"
	MenuConfig      = "config"
	MenuPipelines   = "pipelines"
	MenuBuildConfig = "buildconfig"
	MenuRegistry    = "registry"
	MenuMarket      = "market"
	MenuCredentials = "credentials"
	MenuWorkspaces  = "workspaces"
	MenuUsers       = "users"
	MenuAudit       = "audit"
	MenuClusters    = "clusters"
)

// AllMenuKeys 返回全部已注册菜单 key（启动迁移用 + API 列表返回用）
func AllMenuKeys() []string {
	return []string{
		MenuOverview, MenuWorkloads, MenuNodes, MenuStorage, MenuNetwork, MenuConfig,
		MenuPipelines, MenuBuildConfig, MenuRegistry, MenuMarket, MenuCredentials,
		MenuWorkspaces, MenuUsers, MenuAudit, MenuClusters,
	}
}

// DefaultMenuPermissions 4 个系统内置角色的默认可见菜单（启动迁移写表，幂等）
// 设计原则：platform-admin 全可见；workspace-admin 除「集群管理」外全可见；
// developer 除「企业空间/用户与角色/审计/集群管理」外可见；viewer 仅只读类。
var DefaultMenuPermissions = map[string][]string{
	RolePlatformAdmin: AllMenuKeys(),
	RoleWorkspaceAdmin: {
		MenuOverview, MenuWorkloads, MenuNodes, MenuStorage, MenuNetwork, MenuConfig,
		MenuPipelines, MenuBuildConfig, MenuRegistry, MenuMarket, MenuCredentials,
		MenuWorkspaces, MenuUsers, MenuAudit,
		// 平台管理员才能看 clusters
	},
	RoleDeveloper: {
		MenuOverview, MenuWorkloads, MenuNodes, MenuStorage, MenuNetwork, MenuConfig,
		MenuPipelines, MenuBuildConfig, MenuRegistry, MenuMarket, MenuCredentials,
		// 不能看企业空间、用户管理、审计、集群管理
	},
	RoleViewer: {
		MenuOverview, MenuWorkloads, MenuNodes, MenuStorage, MenuPipelines, MenuRegistry, MenuCredentials,
		// 只读类
	},
}