package model

// Role 平台角色（RBAC）。
// 设计：4 个系统内置角色 + 任意自定义角色。
// 平台管理员（slug=platform-admin）拥有所有集群的所有权限；其余角色需经 UserClusterPermission 显式分配。
type Role struct {
	ID          uint   `gorm:"primarykey" json:"-"`
	Slug        string `gorm:"uniqueIndex;size:64" json:"slug"` // 平台管理员 / 空间管理员 / 开发者 / 访客 / 自定义
	Name        string `json:"name"`
	Description string `json:"description"`
	IsSystem    bool   `gorm:"index" json:"isSystem"`  // 系统内置禁止删
	SortOrder   int    `json:"sortOrder"`              // 列表排序权重
}

// 系统内置角色 slug 常量
const (
	RolePlatformAdmin  = "platform-admin"  // 超级管理员，所有集群所有权限
	RoleWorkspaceAdmin = "workspace-admin" // 空间管理员，单集群所有 namespace（除系统隔离）
	RoleDeveloper      = "developer"       // 开发者，单集群写入 + 读取
	RoleViewer         = "viewer"          // 访客，只读
)
