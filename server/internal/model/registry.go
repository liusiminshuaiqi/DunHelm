package model

import (
	"gorm.io/gorm"

	"kubehelm/server/internal/crypto"
)

// Repo 镜像仓库
type Repo struct {
	ID         uint      `gorm:"primarykey" json:"id"`
	Name       string    `json:"name"`
	Visibility string    `json:"visibility"` // public | private
	Favorite   bool      `json:"favorite"`
	Tags       int       `json:"tags"`
	Size       string    `json:"size"`
	Pulls      int       `json:"pulls"`
	LastPush   string    `json:"lastPush"`
	TagList    []RepoTag `gorm:"foreignKey:RepoID" json:"tagList"`
}

// VulnSummary 漏洞分级，由 AfterFind 从各计数字段组装
type VulnSummary struct {
	Critical int `json:"critical"`
	High     int `json:"high"`
	Medium   int `json:"medium"`
	Low      int `json:"low"`
}

// RepoTag 仓库 Tag 及其 CVE 漏洞统计
type RepoTag struct {
	ID           uint       `gorm:"primarykey" json:"-"`
	RepoID       uint       `json:"-"`
	Name         string     `json:"name"`
	Size         string     `json:"size"`
	Pushed       string     `json:"pushed"`
	VulnCritical int        `json:"-"`
	VulnHigh     int        `json:"-"`
	VulnMedium   int        `json:"-"`
	VulnLow      int        `json:"-"`
	Vuln        VulnSummary `gorm:"-" json:"vuln"`
}

// AfterFind 查询后自动组装 vuln 分级对象
func (t *RepoTag) AfterFind(*gorm.DB) error {
	t.Vuln = VulnSummary{Critical: t.VulnCritical, High: t.VulnHigh, Medium: t.VulnMedium, Low: t.VulnLow}
	return nil
}

// RegistryEndpoint 镜像仓库连接配置。
// 支持「多镜像仓库」场景：一条记录代表一个外部仓库连接（如客户有多个 Harbor /
// 阿里云 ACR / Docker Hub）。页面顶部用连接选择器切换，与多集群设计一致。
//
// 安全：Password 字段落库前由 BeforeSave 钩子加密（AES-GCM），DB 中仅存密文；
// 读取后由 AfterFind 钩子解密，供前端回填与后端建立真实连接使用。
type RegistryEndpoint struct {
	ID          uint   `gorm:"primarykey" json:"id"`
	// 归属集群（多集群隔离）：镜像仓库连接挂在哪个集群下，列表按此过滤。
	ClusterID   uint   `gorm:"index" json:"clusterId"`
	Name        string `json:"name"`       // 连接显示名，如 "生产 Harbor"
	Type        string `json:"type"`       // harbor | dockerhub | acr
	URL         string `json:"url"`        // https://harbor.example.com
	Username    string `json:"username"`
	Password    string `json:"password"`
	Namespace   string `json:"namespace"`  // Docker Hub：org / 用户（可选）
	InsecureTLS bool   `json:"insecureTls"` // 跳过证书校验（自签 Harbor）
	CreatedAt   string `json:"createdAt"`
}

// BeforeSave 落库前加密密码（DB 仅存密文）。
func (e *RegistryEndpoint) BeforeSave(*gorm.DB) error {
	if e.Password != "" {
		enc, err := crypto.Encrypt(e.Password)
		if err != nil {
			return err
		}
		e.Password = enc
	}
	return nil
}

// AfterFind 读取后解密密码，供前端回填与后端连接使用。
// 解密失败（如历史明文或密钥不匹配）保留原值，不阻断读取。
func (e *RegistryEndpoint) AfterFind(*gorm.DB) error {
	if e.Password != "" {
		if dec, err := crypto.Decrypt(e.Password); err == nil {
			e.Password = dec
		}
	}
	return nil
}
