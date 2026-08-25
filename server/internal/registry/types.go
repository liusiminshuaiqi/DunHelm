// Package registry 提供外部镜像仓库（Harbor / Docker Hub / Azure ACR）的统一客户端。
//
// 设计目标：
//   - 多镜像仓库：每个 RegistryEndpoint 对应一个 Client，互不干扰。
//   - 可替换：新增仓库类型只需在包内实现 Client 接口，并在 New 工厂中按 Type 分发，
//     后端 handler 与前端均无需感知具体类型。
package registry

import "kubehelm/server/internal/model"

// VulnSummary 漏洞分级统计（跨类型统一视图）。
type VulnSummary struct {
	Critical int `json:"critical"`
	High     int `json:"high"`
	Medium   int `json:"medium"`
	Low      int `json:"low"`
}

// ProjectView 「项目」统一视图（Harbor 项目 / Docker Hub 命名空间 / ACR 合成单项目）。
type ProjectView struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Public    bool   `json:"public"`
	RepoCount int    `json:"repoCount"`
	QuotaUsed int64  `json:"quotaUsed"`
	QuotaHard int64  `json:"quotaHard"`
}

// RepoView 「仓库」统一视图。
//   - Name：展示用的完整仓库路径（如 "team/app" 或 "library/nginx"）。
//   - Repo：传给 artifacts 接口的纯仓库名（不含 registry / 项目前缀，但保留子路径）。
type RepoView struct {
	Name          string `json:"name"`
	Repo          string `json:"repo"`
	ArtifactCount int    `json:"artifactCount"`
	UpdateTime    string `json:"updateTime"`
}

// ArtifactTag 镜像版本 tag。
type ArtifactTag struct {
	Name     string `json:"name"`
	PushTime string `json:"pushTime"`
}

// ArtifactView 「镜像版本」统一视图（含 tag 与漏洞统计）。
type ArtifactView struct {
	Digest   string        `json:"digest"`
	Size     int64         `json:"size"`
	PushTime string        `json:"pushTime"`
	Tags     []ArtifactTag `json:"tags"`
	Vuln     VulnSummary   `json:"vuln"`
}

// Client 统一镜像仓库客户端接口。
// 所有具体实现（Harbor / Docker Hub / ACR）都必须满足该接口，便于后端按类型分发。
type Client interface {
	ListProjects() ([]ProjectView, error)
	CreateProject(name string, public bool) (int, error)
	UpdateProject(name string, public bool) (int, error)
	DeleteProject(name string) (int, error)
	ListRepositories(project string) ([]RepoView, error)
	ListArtifacts(project, repo string) ([]ArtifactView, error)
	// ProjectSummary 返回项目的真实存储用量与仓库数（字节；硬配额若为 -1 表示未配置）。
	// Harbor 通过 GET /projects/{name}/summary 一次拿到，是该端点直接给出的统计值。
	ProjectSummary(project string) (usedBytes int64, hardBytes int64, repoCount int, err error)
	// ProjectUsage 兼容旧接口，内部转调 ProjectSummary。
	// 历史实现是遍历全部仓库 + 镜像 + 按 digest 去重累加 size，N 个项目每次需要 N×M 次 HTTP，
	// 性能差；Harbor 的 summary 接口是一次 RTT 的官方值，更准也更快。
	ProjectUsage(project string) (int64, error)
	// DeleteArtifact 删除某个镜像版本（制品）。reference 为 digest 或 tag。
	// 删除按 artifact（同一 digest 可能挂多个 tag）进行，删除后这些 tag 一并消失。
	DeleteArtifact(project, repo, reference string) (int, error)
	// DeleteRepository 删除整个仓库（镜像名），连同其下全部版本。
	DeleteRepository(project, repo string) (int, error)
	// Ping 探测连接是否可用：网络可达 + 凭证有效。返回 nil 表示联通成功。
	// 不同仓库类型各自实现：Harbor 试认证拉项目列表、Docker Hub 试拉命名空间仓库、
	// ACR 走 oauth2 token + _catalog。
	Ping() error
}

// Test 验证一个连接配置（model.RegistryEndpoint）是否可用：构造对应客户端并探测。
// 既可用于「创建前预检」，也可传入已存连接（密码为解密明文）做「编辑后复核」。
func Test(ep model.RegistryEndpoint) error {
	return New(ep).Ping()
}

// New 按连接类型构造对应客户端；未知类型回退为 Harbor。
func New(ep model.RegistryEndpoint) Client {
	switch ep.Type {
	case "dockerhub":
		return NewDockerHub(ep)
	case "acr":
		return NewACR(ep)
	default:
		return NewHarbor(ep)
	}
}
