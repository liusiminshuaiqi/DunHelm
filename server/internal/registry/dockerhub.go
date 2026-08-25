package registry

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"kubehelm/server/internal/model"
)

// DockerHubClient 访问 Docker Hub Hub API v2（https://hub.docker.com/v2）。
//
// Docker Hub 没有「项目」概念：将连接配置的 Namespace（org 或 user）映射为一个项目，
// 其下仓库与 tag 通过 Hub API 浏览。创建仓库需经 `docker push` 触发，API 不支持。
type DockerHubClient struct {
	BaseURL   string
	Username  string
	Password  string
	Namespace string
	http      *http.Client
}

// NewDockerHub 构造客户端。URL 缺省为 https://hub.docker.com。
func NewDockerHub(ep model.RegistryEndpoint) *DockerHubClient {
	base := strings.TrimRight(ep.URL, "/")
	if base == "" {
		base = "https://hub.docker.com"
	}
	tr := &http.Transport{
		MaxIdleConns:        50,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		DialContext:         DialContextWithCache,
		TLSHandshakeTimeout: 5 * time.Second,
	}
	return &DockerHubClient{
		BaseURL:   base,
		Username:  ep.Username,
		Password:  ep.Password,
		Namespace: ep.Namespace,
		http:      &http.Client{Transport: tr, Timeout: 20 * time.Second},
	}
}

func (c *DockerHubClient) do(method, path string, out interface{}) (int, error) {
	req, err := http.NewRequest(method, c.BaseURL+path, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	if c.Username != "" {
		auth := base64.StdEncoding.EncodeToString([]byte(c.Username + ":" + c.Password))
		req.Header.Set("Authorization", "Basic "+auth)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, fmt.Errorf("dockerhub %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if out != nil && resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return resp.StatusCode, nil
		}
	}
	return resp.StatusCode, nil
}

// ListProjects 返回连接配置的命名空间（单项目）。未配置时报错提示。
func (c *DockerHubClient) ListProjects() ([]ProjectView, error) {
	if c.Namespace == "" {
		return nil, fmt.Errorf("请在连接配置中填写 Docker Hub 命名空间（org 或 user）")
	}
	return []ProjectView{{Name: c.Namespace, Public: false, RepoCount: 0}}, nil
}

// Ping 探测 Docker Hub 连接：用当前凭证拉一次命名空间仓库列表（page_size=1）。
// 命名空间未填 → 配置错误；网络不可达 → 网络错误；凭证无效 → 401 错误；成功 → nil。
func (c *DockerHubClient) Ping() error {
	if c.Namespace == "" {
		return fmt.Errorf("请在连接配置中填写 Docker Hub 命名空间（org 或 user）")
	}
	path := "/v2/repositories/" + url.PathEscape(c.Namespace) + "/?page_size=1"
	_, err := c.do(http.MethodGet, path, nil)
	return err
}

// CreateProject Docker Hub 不支持 API 创建仓库。
func (c *DockerHubClient) CreateProject(name string, public bool) (int, error) {
	return 0, fmt.Errorf("Docker Hub 不支持通过 API 创建仓库，请使用 `docker push` 触发创建")
}

// UpdateProject Docker Hub 不支持通过 API 修改公开/私有（需在 Docker Hub 控制台操作）。
func (c *DockerHubClient) UpdateProject(name string, public bool) (int, error) {
	return 0, fmt.Errorf("Docker Hub 不支持通过 API 修改公开/私有，请在 Docker Hub 控制台操作")
}

// DeleteProject Docker Hub 不支持通过 API 删除仓库。
func (c *DockerHubClient) DeleteProject(name string) (int, error) {
	return 0, fmt.Errorf("Docker Hub 不支持通过 API 删除仓库，请在 Docker Hub 控制台操作")
}

// ProjectSummary Docker Hub 不直接给出仓库占用字节数（需逐一 inspect tag），返回 0。
func (c *DockerHubClient) ProjectSummary(project string) (int64, int64, int, error) {
	return 0, 0, 0, nil
}

// ProjectUsage Docker Hub 暂未聚合真实体积（需逐 tag 取 image size）。
func (c *DockerHubClient) ProjectUsage(project string) (int64, error) {
	return 0, nil
}

// DeleteArtifact Docker Hub 不支持通过 API 删除镜像版本。
func (c *DockerHubClient) DeleteArtifact(project, repo, reference string) (int, error) {
	return 0, fmt.Errorf("Docker Hub 不支持通过 API 删除镜像，请在 Docker Hub 控制台操作")
}

// DeleteRepository Docker Hub 不支持通过 API 删除仓库。
func (c *DockerHubClient) DeleteRepository(project, repo string) (int, error) {
	return 0, fmt.Errorf("Docker Hub 不支持通过 API 删除仓库，请在 Docker Hub 控制台操作")
}

// ListRepositories 列出命名空间下的仓库。
func (c *DockerHubClient) ListRepositories(project string) ([]RepoView, error) {
	var data struct {
		Results []struct {
			Name        string `json:"name"` // namespace/repo
			LastUpdated string `json:"last_updated"`
		} `json:"results"`
	}
	path := "/v2/repositories/" + url.PathEscape(project) + "/?page_size=100"
	if _, err := c.do(http.MethodGet, path, &data); err != nil {
		return nil, err
	}
	out := make([]RepoView, 0, len(data.Results))
	for _, r := range data.Results {
		repo := r.Name
		if idx := strings.Index(r.Name, "/"); idx >= 0 {
			repo = r.Name[idx+1:]
		}
		out = append(out, RepoView{Name: r.Name, Repo: repo, UpdateTime: r.LastUpdated})
	}
	return out, nil
}

// ListArtifacts 列出某仓库的 tag。
func (c *DockerHubClient) ListArtifacts(project, repo string) ([]ArtifactView, error) {
	var data struct {
		Results []struct {
			Name        string `json:"name"`
			LastUpdated string `json:"last_updated"`
			Images      []struct {
				Size int64 `json:"size"`
			} `json:"images"`
		} `json:"results"`
	}
	path := "/v2/repositories/" + url.PathEscape(project) + "/" + url.PathEscape(repo) + "/tags/?page_size=100"
	if _, err := c.do(http.MethodGet, path, &data); err != nil {
		return nil, err
	}
	out := make([]ArtifactView, 0, len(data.Results))
	for _, t := range data.Results {
		size := int64(0)
		if len(t.Images) > 0 {
			size = t.Images[0].Size
		}
		out = append(out, ArtifactView{
			Digest:   t.Name,
			Size:     size,
			PushTime: t.LastUpdated,
			Tags:     []ArtifactTag{{Name: t.Name, PushTime: t.LastUpdated}},
		})
	}
	return out, nil
}
