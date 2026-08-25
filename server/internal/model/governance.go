package model

import "time"

// Workspace 企业空间
type Workspace struct {
	ID        uint   `gorm:"primarykey" json:"-"`
	Name      string `json:"name"`
	Admin     string `json:"admin"`
	Projects  int    `json:"projects"`
	Members   int    `json:"members"`
	QuotaCpu  int    `json:"quotaCpu"`
	QuotaMem  int    `json:"quotaMem"`
	Status    string `json:"status"`
}

// DefaultUserPassword 内置用户与新建用户的统一初始密码（首次 seed / 旧库补齐 / 空密码创建时采用）。
// 生产环境应在首次登录后通过「重置密码」改为强密码。
const DefaultUserPassword = "DunHelm@2026"

// User 平台用户
// Role 字段保留为"平台默认角色"快照，权限的真实源是 UserClusterPermission；
// 平台管理员（slug=platform-admin）自动拥有所有集群所有权限（middleware bypass）。
type User struct {
	ID        uint   `gorm:"primarykey" json:"id"`
	Name      string `json:"name"`
	Role      string `json:"role"` // platform-admin / workspace-admin / developer / viewer
	Email     string `json:"email"`
	Status    string `json:"status"`    // ok / pending / locked
	Active    bool   `gorm:"index;default:true" json:"active"` // 启用/禁用，禁用登录拒绝
	Password  string `gorm:"size:128" json:"-"`                // bcrypt 哈希，绝不返回前端
	LastLogin string `json:"lastLogin"`
	CreatedAt string `json:"createdAt"`
}

// Credential 代码凭证。
// 来源两类：(1) 真实集群的 K8s Secret（带 Namespace，SecretRef 形如 secret/<name>，K8s 命名空间内唯一）；
// (2) 本地 DB 演示数据（Namespace 为空，SecretRef 为占位串）。
type Credential struct {
	ID        uint   `gorm:"primarykey" json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Scope     string `json:"scope"`
	SecretRef string `json:"secretRef"`
	CreatedBy string `json:"createdBy"`
	LastUsed  string `json:"lastUsed"`
	Status    string `json:"status"`
	// Namespace 仅真实集群 Secret 有值（DB 演示数据为空）
	Namespace string `json:"namespace,omitempty"`
}

// CredentialInput 创建凭证请求体（落到真实集群 K8s Secret 或本地 DB）。
// Data 为 Secret 的明文键值（后端负责 base64 编码），按 Type 解释：
//   GitHub/GitLab/Gitee -> {"token": ...}
//   Harbor/Docker Hub   -> {"username","password","registry?"}
//   SSH                 -> {"privateKey": ...}
//   KubeConfig          -> {"kubeconfig": ...}
//   TLS                 -> {"cert","key"}
type CredentialInput struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Type      string            `json:"type"`
	Scope     string            `json:"scope"`
	Data      map[string]string `json:"data"`
	CreatedBy string            `json:"createdBy"`
}

// AuditLog 审计日志（结构化）
// 设计：除 id/time 必填外，actor/resource/result 都按维度拆字段，便于多维筛选与聚合。
// Time 用 time.Time 以便按时间范围查询；JSON 输出用 RFC3339Nano（前端可格式化）。
type AuditLog struct {
	ID           uint      `gorm:"primarykey" json:"id"`
	Time         time.Time `gorm:"index" json:"time"`                          // RFC3339Nano
	ActorID      uint      `gorm:"index" json:"actorId"`                       // 用户 ID（platform-admin 等无 uid 的用 0）
	ActorName    string    `gorm:"size:64;index" json:"actorName"`             // 用户名（admin 兜底）
	Action        string   `gorm:"size:64;index" json:"action"`                 // login / user.create / user.delete / role.create / permission.assign / pipeline.run ...
	ResourceType  string   `gorm:"size:32;index" json:"resourceType"`           // user / role / permission / cluster / pipeline / credential / build / registry ...
	ResourceName  string   `gorm:"size:128" json:"resourceName"`               // 资源标识（用户名 / 角色 slug / 流水线名）
	ClusterID     uint     `gorm:"index" json:"clusterId"`                     // 0 = 平台级
	Result        string   `gorm:"size:16;index" json:"result"`                 // ok / denied / error
	Detail        string   `gorm:"type:text" json:"detail"`                     // 补充 JSON/字符串（如 "clusterId=5, roleSlug=developer"）
	IP            string   `gorm:"size:64" json:"ip"`                           // 客户端 IP
	UserAgent     string   `gorm:"size:256" json:"userAgent"`                   // 客户端 UA
}

// 标准 action 常量（埋点统一引用，避免散落字符串）
const (
	AuditLogin           = "login"
	AuditLoginFailed     = "login.failed"
	AuditUserCreate      = "user.create"
	AuditUserUpdate      = "user.update"
	AuditUserDelete      = "user.delete"
	AuditUserSetActive   = "user.set_active"
	AuditUserSetStatus   = "user.set_status"
	AuditRoleCreate      = "role.create"
	AuditRoleUpdate      = "role.update"
	AuditRoleDelete      = "role.delete"
	AuditRoleMenuSet     = "role.menu.set"
	AuditPermAssign      = "permission.assign"
	AuditPermRevoke      = "permission.revoke"
	AuditClusterRegister = "cluster.register"
	AuditClusterDelete   = "cluster.delete"
	AuditPipelineCreate  = "pipeline.create"
	AuditPipelineUpdate  = "pipeline.update"
	AuditPipelineDelete  = "pipeline.delete"
	AuditPipelineRun     = "pipeline.run"
	AuditPipelineRunAbort = "pipeline.run.abort"
	AuditCredentialCreate = "credential.create"
	AuditCredentialDelete = "credential.delete"
	AuditRegistryCreate  = "registry.create"
	AuditRegistryUpdate  = "registry.update"
	AuditUserResetPassword = "user.reset_password"
	AuditRegistryDelete  = "registry.delete"
	AuditForbidden       = "forbidden" // middleware 拒绝
)
