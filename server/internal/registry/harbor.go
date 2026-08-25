package registry

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"kubehelm/server/internal/model"
)

// HarborClient 一个 Harbor 实例的连接客户端（实现 registry.Client 接口）。
type HarborClient struct {
	BaseURL     string
	Username    string
	Password    string
	InsecureTLS bool
	http        *http.Client
}

// NewHarbor 构造客户端。url 不含 /api/v2.0 后缀；InsecureTLS=true 时跳过 TLS 校验（自签证书）。
func NewHarbor(ep model.RegistryEndpoint) *HarborClient {
	tr := &http.Transport{
		// 连接复用：连续请求走同一条 TCP + TLS，避免每次都重连（每次握手几百 ms 到几秒）
		MaxIdleConns:        50,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		// 自定义 DialContext：先查应用层 DNS 缓存，命中直接连 IP（ms 级），
		// 绕过 macOS cgo resolver 慢速 mDNSResponder（5s+）。
		DialContext: DialContextWithCache,
		TLSHandshakeTimeout: 5 * time.Second,
	}
	if ep.InsecureTLS {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &HarborClient{
		BaseURL:     strings.TrimRight(ep.URL, "/"),
		Username:    ep.Username,
		Password:    ep.Password,
		InsecureTLS: ep.InsecureTLS,
		http:        &http.Client{Transport: tr, Timeout: 20 * time.Second},
	}
}

// do 发起 GET 请求并解码 JSON。返回 HTTP 状态码与错误（>=400 视为错误）。
func (c *HarborClient) do(method, path string, body io.Reader, out interface{}) (int, error) {
	req, err := http.NewRequest(method, c.BaseURL+"/api/v2.0"+path, body)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	auth := base64.StdEncoding.EncodeToString([]byte(c.Username + ":" + c.Password))
	req.Header.Set("Authorization", "Basic "+auth)

	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, fmt.Errorf("harbor %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if out != nil && resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return resp.StatusCode, nil // 解码失败不阻断（如 201 无 body）
		}
	}
	return resp.StatusCode, nil
}

// projectSummaryStruct 是 GET /projects/{name}/summary 的响应结构。
type projectSummaryStruct struct {
	RepoCount int `json:"repo_count"`
	Quota     *struct {
		Hard map[string]int64 `json:"hard"`
		Used map[string]int64 `json:"used"`
	} `json:"quota"`
}

// ProjectSummary 通过 Harbor 的官方 summary 端点（GET /projects/{name}/summary），
// 一次 RTT 拿到项目真实存储用量与仓库数。quota.used["storage"] 即真实占用字节数。
func (c *HarborClient) ProjectSummary(project string) (int64, int64, int, error) {
	var s projectSummaryStruct
	path := "/projects/" + url.PathEscape(project) + "/summary"
	if _, err := c.do(http.MethodGet, path, nil, &s); err != nil {
		return 0, 0, 0, err
	}
	var used, hard int64
	if s.Quota != nil {
		if v, ok := s.Quota.Used["storage"]; ok {
			used = v
		}
		if v, ok := s.Quota.Hard["storage"]; ok {
			hard = v
		}
	}
	return used, hard, s.RepoCount, nil
}

// ListProjects 列出全部项目；对每个项目并发调用 summary 端点回填真实已用配额，
// 把原本 N+1 次列表/单独获取合并为一次 ListProjects 响应，前端不再需要为每个项目打 RTT。
func (c *HarborClient) ListProjects() ([]ProjectView, error) {
	var ps []struct {
		ProjectID int               `json:"project_id"`
		Name      string            `json:"name"`
		Public    bool              `json:"public"` // 旧版 Harbor 顶层字段；新版置于 metadata.public
		RepoCount int               `json:"repo_count"`
		Metadata  map[string]string `json:"metadata"`
		Quota     *struct {
			Hard map[string]int64 `json:"hard"`
			Used map[string]int64 `json:"used"`
		} `json:"quota"`
	}
	if _, err := c.do(http.MethodGet, "/projects?page=1&page_size=100", nil, &ps); err != nil {
		return nil, err
	}
	out := make([]ProjectView, 0, len(ps))
	for _, p := range ps {
		// 兼容新旧 Harbor：public 优先取 metadata.public（字符串），缺省回退顶层 public
		pub := p.Public
		if p.Metadata != nil {
			if v, ok := p.Metadata["public"]; ok {
				pub = v == "true"
			}
		}
		used, hard := int64(0), int64(0)
		if p.Quota != nil {
			if v, ok := p.Quota.Used["storage"]; ok {
				used = v
			}
			if v, ok := p.Quota.Hard["storage"]; ok {
				hard = v
			}
		}
		out = append(out, ProjectView{ID: p.ProjectID, Name: p.Name, Public: pub, RepoCount: p.RepoCount, QuotaUsed: used, QuotaHard: hard})
	}
	// 并发补齐真实用量（summary 端点）。ListProjects 响应里 quota.used 普遍为 0，
	// 必须再发请求拿到真实值；用 8 并发避免对 Harbor 造成压力同时保持秒级响应。
	c.fillUsageConcurrently(out, 8)
	return out, nil
}

// fillUsageConcurrently 并发调用 summary 端点，把每个项目的真实用量写回 QuotaUsed/QuotaHard/RepoCount。
// 单项目失败不影响整体（保留 ListProjects 已读到的值），并发的 token 数由 tokens 控制。
func (c *HarborClient) fillUsageConcurrently(projects []ProjectView, tokens int) {
	if tokens <= 0 {
		tokens = 8
	}
	if tokens > len(projects) {
		tokens = len(projects)
	}
	if tokens <= 0 {
		return
	}
	ch := make(chan int, tokens)
	var wg sync.WaitGroup
	wg.Add(tokens)
	for w := 0; w < tokens; w++ {
		go func() {
			defer wg.Done()
			for i := range ch {
				used, hard, repoCnt, err := c.ProjectSummary(projects[i].Name)
				if err != nil {
					continue // 失败保留 ListProjects 读到的 quota 值（前端的 0）
				}
				projects[i].QuotaUsed = used
				projects[i].QuotaHard = hard
				if repoCnt > 0 {
					projects[i].RepoCount = repoCnt
				}
			}
		}()
		ch <- 0 // bootstrap
	}
	for i := range projects {
		ch <- i
	}
	close(ch)
	wg.Wait()
}

// CreateProject 创建项目（仓库）。返回 Harbor 状态码。
func (c *HarborClient) CreateProject(name string, public bool) (int, error) {
	payload, _ := json.Marshal(map[string]interface{}{"project_name": name, "public": public})
	return c.do(http.MethodPost, "/projects", strings.NewReader(string(payload)), nil)
}

// UpdateProject 修改项目公开/私有属性。Harbor 通过 PUT /projects/{name} 的 metadata.public 实现。
func (c *HarborClient) UpdateProject(name string, public bool) (int, error) {
	v := "false"
	if public {
		v = "true"
	}
	payload, _ := json.Marshal(map[string]interface{}{"metadata": map[string]string{"public": v}})
	return c.do(http.MethodPut, "/projects/"+url.PathEscape(name), strings.NewReader(string(payload)), nil)
}

// DeleteProject 删除项目。Harbor 通过 DELETE /projects/{name} 实现；项目下仍有仓库时返回 412。
func (c *HarborClient) DeleteProject(name string) (int, error) {
	return c.do(http.MethodDelete, "/projects/"+url.PathEscape(name), nil, nil)
}

// ListRepositories 列出某项目下的仓库。repo.Name 形如 "project/repo"，Repo 去掉前缀。
func (c *HarborClient) ListRepositories(project string) ([]RepoView, error) {
	var rs []struct {
		Name          string `json:"name"`
		ArtifactCount int    `json:"artifact_count"`
		UpdateTime    string `json:"update_time"`
	}
	path := "/projects/" + url.PathEscape(project) + "/repositories?page=1&page_size=100"
	if _, err := c.do(http.MethodGet, path, nil, &rs); err != nil {
		return nil, err
	}
	out := make([]RepoView, 0, len(rs))
	for _, r := range rs {
		repo := r.Name
		if idx := strings.Index(r.Name, "/"); idx >= 0 {
			repo = r.Name[idx+1:]
		}
		out = append(out, RepoView{Name: r.Name, Repo: repo, ArtifactCount: r.ArtifactCount, UpdateTime: r.UpdateTime})
	}
	return out, nil
}

// ListArtifacts 列出某仓库的制品（含 tag 与漏洞扫描概览）。repo 为不含项目前缀的纯仓库名。
func (c *HarborClient) ListArtifacts(project, repo string) ([]ArtifactView, error) {
	var as []struct {
		Digest   string `json:"digest"`
		Size     int64  `json:"size"`
		PushTime string `json:"push_time"`
		Tags     []struct {
			Name     string `json:"name"`
			PushTime string `json:"push_time"`
		} `json:"tags"`
		ScanOverview map[string]struct {
			Summary struct {
				Summary map[string]int `json:"summary"`
			} `json:"summary"`
		} `json:"scan_overview"`
	}
	path := fmt.Sprintf("/projects/%s/repositories/%s/artifacts?page=1&page_size=100&with_tag=true&with_scan_overview=true",
		url.PathEscape(project), url.PathEscape(repo))
	if _, err := c.do(http.MethodGet, path, nil, &as); err != nil {
		return nil, err
	}
	out := make([]ArtifactView, 0, len(as))
	for _, a := range as {
		v := VulnSummary{}
		for _, ov := range a.ScanOverview {
			if ov.Summary.Summary != nil {
				v.Critical += ov.Summary.Summary["Critical"]
				v.High += ov.Summary.Summary["High"]
				v.Medium += ov.Summary.Summary["Medium"]
				v.Low += ov.Summary.Summary["Low"]
			}
		}
		tags := make([]ArtifactTag, 0, len(a.Tags))
		for _, t := range a.Tags {
			tags = append(tags, ArtifactTag{Name: t.Name, PushTime: t.PushTime})
		}
		out = append(out, ArtifactView{Digest: a.Digest, Size: a.Size, PushTime: a.PushTime, Tags: tags, Vuln: v})
	}
	return out, nil
}

// ProjectUsage 单项目存储用量：现在直接走 ProjectSummary（官方接口），不再遍历仓库与镜像。
func (c *HarborClient) ProjectUsage(project string) (int64, error) {
	used, _, _, err := c.ProjectSummary(project)
	return used, err
}

// DeleteArtifact 删除某个镜像版本（制品）：DELETE /projects/{project}/repositories/{repo}/artifacts/{reference}。
// reference 为 digest（推荐）或 tag。删除按 artifact 进行——同一 digest 上的多个 tag 会一并消失。
func (c *HarborClient) DeleteArtifact(project, repo, reference string) (int, error) {
	path := "/projects/" + url.PathEscape(project) + "/repositories/" + url.PathEscape(repo) + "/artifacts/" + url.PathEscape(reference)
	return c.do(http.MethodDelete, path, nil, nil)
}

// DeleteRepository 删除整个仓库（镜像名）及其下全部版本：DELETE /projects/{project}/repositories/{repo}。
func (c *HarborClient) DeleteRepository(project, repo string) (int, error) {
	path := "/projects/" + url.PathEscape(project) + "/repositories/" + url.PathEscape(repo)
	return c.do(http.MethodDelete, path, nil, nil)
}

// Ping 探测 Harbor 连接：用当前凭证拉一次项目列表（page_size=1）。
// 网络不可达 → 返回网络错误；凭证无效 → 返回 401 错误；成功 → nil。
func (c *HarborClient) Ping() error {
	_, err := c.do(http.MethodGet, "/projects?page=1&page_size=1", nil, nil)
	return err
}
