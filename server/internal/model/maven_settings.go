package model

import (
	"kubehelm/server/internal/crypto"

	"gorm.io/gorm"
)

// MavenGlobalSettings 集群级 Maven settings.xml（全局 mirror / proxy），按集群隔离配置，
// 每个集群一条记录（Where cluster_id = ?）。同一集群内所有流水线构建共享该集群的配置。
// 通常不含密钥（凭证走流水级 Secret）；落库统一 AES-GCM 加密，读出口由 AfterFind 解密，
// 供引擎挂载到该集群的构建 Pod（只读）使用。
type MavenGlobalSettings struct {
	ID        uint   `gorm:"primarykey" json:"-"`
	ClusterID uint   `gorm:"index" json:"clusterId"`
	Content   string `json:"content"` // settings.xml 全文（mirror / proxy 等）
	UpdatedAt string `json:"updatedAt"`
}

// BeforeSave 落库前加密（DB 仅存密文）。
func (m *MavenGlobalSettings) BeforeSave(*gorm.DB) error {
	if m.Content != "" {
		if enc, err := crypto.Encrypt(m.Content); err == nil {
			m.Content = enc
		}
	}
	return nil
}

// AfterFind 读取后解密（失败保留原值，不阻断读取）。
func (m *MavenGlobalSettings) AfterFind(*gorm.DB) error {
	if m.Content != "" {
		if dec, err := crypto.Decrypt(m.Content); err == nil {
			m.Content = dec
		}
	}
	return nil
}
