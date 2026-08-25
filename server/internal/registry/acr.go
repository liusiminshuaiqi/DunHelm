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

// ACRClient 访问 Azure Container Registry（OCI Distribution v2 + oauth2 令牌）。
//
// ACR 没有「项目」概念：单一合成项目（registry 名），其下仓库通过 _catalog 浏览。
// 创建仓库需经 `az acr import` / `docker push` 触发，API 不支持。
type ACRClient struct {
	Host     string // myregistry.azurecr.io
	Username string
	Password string
	http     *http.Client
}

// NewACR 构造客户端。URL 形如 https://myregistry.azurecr.io。
func NewACR(ep model.RegistryEndpoint) *ACRClient {
	host := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(ep.URL, "https://"), "http://"), "/")
	tr := &http.Transport{
		MaxIdleConns:        50,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		DialContext:         DialContextWithCache,
		TLSHandshakeTimeout: 5 * time.Second,
	}
	return &ACRClient{Host: host, Username: ep.Username, Password: ep.Password, http: &http.Client{Transport: tr, Timeout: 20 * time.Second}}
}

func (c *ACRClient) base() string { return "https://" + c.Host }

// token 获取 oauth2 bearer token（Basic auth 换 token）。
func (c *ACRClient) token(scope string) (string, error) {
	u := c.base() + "/oauth2/token?service=" + url.QueryEscape(c.Host) + "&scope=" + url.QueryEscape(scope)
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	if c.Username != "" {
		auth := base64.StdEncoding.EncodeToString([]byte(c.Username + ":" + c.Password))
		req.Header.Set("Authorization", "Basic "+auth)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("acr token %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var data struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", err
	}
	return data.Token, nil
}

func (c *ACRClient) doAuth(method, path, scope string, out interface{}) (int, error) {
	tok, err := c.token(scope)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequest(method, c.base()+path, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, fmt.Errorf("acr %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if out != nil && resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return resp.StatusCode, nil
		}
	}
	return resp.StatusCode, nil
}

// ListProjects 返回合成单项目（registry 名）。
func (c *ACRClient) ListProjects() ([]ProjectView, error) {
	return []ProjectView{{Name: c.Host, Public: false, RepoCount: 0}}, nil
}

// Ping 探测 ACR 连接：用当前凭证换 oauth2 token 并拉一次 _catalog。
// 网络不可达或凭证无效 → 返回错误；成功 → nil。
func (c *ACRClient) Ping() error {
	_, err := c.doAuth(http.MethodGet, "/v2/_catalog", "registry:catalog:*", nil)
	return err
}

// CreateProject ACR 不支持 API 创建仓库。
func (c *ACRClient) CreateProject(name string, public bool) (int, error) {
	return 0, fmt.Errorf("ACR 不支持通过 API 创建仓库，请使用 `az acr import` / `docker push` 触发创建")
}

// UpdateProject ACR 仓库均为私有，不支持通过 API 切换公开/私有。
func (c *ACRClient) UpdateProject(name string, public bool) (int, error) {
	return 0, fmt.Errorf("ACR 仓库均为私有，不支持通过 API 切换公开/私有")
}

// DeleteProject ACR 不支持通过 API 删除仓库。
func (c *ACRClient) DeleteProject(name string) (int, error) {
	return 0, fmt.Errorf("ACR 不支持通过 API 删除仓库，请使用 `az acr repository delete` 或在控制台操作")
}

// ProjectSummary ACR 不直接给出仓库占用字节数，返回 0。
func (c *ACRClient) ProjectSummary(project string) (int64, int64, int, error) {
	return 0, 0, 0, nil
}

// ProjectUsage ACR tag 列表不含 size，暂不聚合真实体积。
func (c *ACRClient) ProjectUsage(project string) (int64, error) {
	return 0, nil
}

// DeleteArtifact ACR 不支持通过 API 删除镜像版本。
func (c *ACRClient) DeleteArtifact(project, repo, reference string) (int, error) {
	return 0, fmt.Errorf("ACR 不支持通过 API 删除镜像版本，请使用 `az acr repository delete` 或在控制台操作")
}

// DeleteRepository ACR 不支持通过 API 删除仓库。
func (c *ACRClient) DeleteRepository(project, repo string) (int, error) {
	return 0, fmt.Errorf("ACR 不支持通过 API 删除仓库，请使用 `az acr repository delete` 或在控制台操作")
}

// ListRepositories 通过 _catalog 列出全部仓库（忽略 project 参数）。
func (c *ACRClient) ListRepositories(project string) ([]RepoView, error) {
	var data struct {
		Repositories []string `json:"repositories"`
	}
	if _, err := c.doAuth(http.MethodGet, "/v2/_catalog", "registry:catalog:*", &data); err != nil {
		return nil, err
	}
	out := make([]RepoView, 0, len(data.Repositories))
	for _, r := range data.Repositories {
		out = append(out, RepoView{Name: r, Repo: r})
	}
	return out, nil
}

// ListArtifacts 列出某仓库的 tag。
func (c *ACRClient) ListArtifacts(project, repo string) ([]ArtifactView, error) {
	var data struct {
		Name []string `json:"name"`
	}
	scope := "registry:repository:" + repo + ":pull"
	if _, err := c.doAuth(http.MethodGet, "/v2/"+url.PathEscape(repo)+"/tags/list", scope, &data); err != nil {
		return nil, err
	}
	out := make([]ArtifactView, 0, len(data.Name))
	for _, t := range data.Name {
		out = append(out, ArtifactView{Digest: t, Tags: []ArtifactTag{{Name: t}}})
	}
	return out, nil
}
