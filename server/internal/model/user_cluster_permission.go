package model

// UserClusterPermission 用户对单个集群的授权。
// 同一用户对同一集群仅一条记录（联合唯一索引）。NamespacesJSON 为空=全部 namespace。
// 平台管理员（User.Role == platform-admin）通过 middleware 直接 bypass，不需此表记录。
type UserClusterPermission struct {
	ID             uint   `gorm:"primarykey" json:"-"`
	UserID         uint   `gorm:"uniqueIndex:idx_user_cluster;index" json:"userId"`
	ClusterID      uint   `gorm:"uniqueIndex:idx_user_cluster" json:"clusterId"`
	RoleSlug       string `gorm:"index;size:64" json:"roleSlug"` // 冗余存储 Role.Slug
	NamespacesJSON string `json:"namespacesJson"`                // []string JSON 字符串；空字符串/[]=全 namespace
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}
