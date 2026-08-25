package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kubehelm/server/internal/audit"
	"kubehelm/server/internal/crypto"
	"kubehelm/server/internal/model"
	"kubehelm/server/internal/registry"

	"github.com/gin-gonic/gin"
)

// loadRegistryClient 从 ?registry=<id> 取出连接配置并构造对应类型的客户端。
// 不做主动 DNS / TCP 探测：让 Harbor http.Client 自己去连接。
//   - 端口没人监听时 TCP 立刻 RST，毫秒级返回 connection refused（不是 5s 超时）；
//   - DNS 解析失败时才走满 5s（cgo resolver 默认超时），但这种情况用户能看明白是 DNS 问题。
// 用户在 /etc/hosts 配了域名但 Harbor 服务端口不通时，期望看到的是 connection refused 而不是 i/o timeout。
func (h *Handler) loadRegistryClient(c *gin.Context) (registry.Client, model.RegistryEndpoint, error) {
	id, err := strconv.ParseUint(c.Query("registry"), 10, 64)
	if err != nil || id == 0 {
		return nil, model.RegistryEndpoint{}, fmt.Errorf("缺少或无效的 registry 参数")
	}
	var ep model.RegistryEndpoint
	if err := h.Store.DB.First(&ep, id).Error; err != nil {
		return nil, model.RegistryEndpoint{}, fmt.Errorf("未找到该镜像仓库连接")
	}
	if strings.TrimSpace(ep.URL) == "" {
		return nil, ep, fmt.Errorf("该镜像仓库未配置 URL")
	}
	return registry.New(ep), ep, nil
}

// Registries 连接列表
func (h *Handler) Registries(c *gin.Context) {
	cid, _ := h.clusterID(c)
	list, err := h.Store.RegistryEndpoints(cid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, list)
}

// CreateRegistry 新增连接
func (h *Handler) CreateRegistry(c *gin.Context) {
	cid, _ := h.clusterID(c)
	var ep model.RegistryEndpoint
	if err := c.ShouldBindJSON(&ep); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if ep.URL == "" || ep.Username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "url 与 username 必填"})
		return
	}
	if ep.Type == "" {
		ep.Type = "harbor"
	}
	ep.ClusterID = cid
	ep.CreatedAt = time.Now().Format("2006-01-02 15:04")
	if err := h.Store.CreateRegistryEndpoint(&ep); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditRegistryCreate, "registry", ep.Name, cid, "ok", "url="+ep.URL+" type="+ep.Type)
	c.JSON(http.StatusCreated, ep)
}

// DeleteRegistry 删除连接
func (h *Handler) DeleteRegistry(c *gin.Context) {
	cid, _ := h.clusterID(c)
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if err := h.Store.DeleteRegistryEndpoint(uint(id), cid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditRegistryDelete, "registry", strconv.FormatUint(id, 10), cid, "ok", "")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// TestRegistry 测试连接配置是否可用（创建前预检 / 编辑后复核）。
// body 可含 id（沿用已存连接，密码缺省复用 DB 中解密值）或完整新配置。
func (h *Handler) TestRegistry(c *gin.Context) {
	var body struct {
		ID          uint   `json:"id"`
		Name        string `json:"name"`
		Type        string `json:"type"`
		URL         string `json:"url"`
		Username    string `json:"username"`
		Password    string `json:"password"`
		Namespace   string `json:"namespace"`
		InsecureTLS bool   `json:"insecureTls"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ep := model.RegistryEndpoint{
		Type:        body.Type,
		URL:         body.URL,
		Username:    body.Username,
		Password:    body.Password,
		Namespace:   body.Namespace,
		InsecureTLS: body.InsecureTLS,
	}
	if body.ID != 0 {
		var dbEp model.RegistryEndpoint
		if err := h.Store.DB.First(&dbEp, body.ID).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "未找到该连接"})
			return
		}
		if ep.Type == "" {
			ep.Type = dbEp.Type
		}
		if ep.URL == "" {
			ep.URL = dbEp.URL
		}
		if ep.Username == "" {
			ep.Username = dbEp.Username
		}
		if ep.Password == "" {
			ep.Password = dbEp.Password // AfterFind 已解密为明文
		}
		if ep.Namespace == "" {
			ep.Namespace = dbEp.Namespace
		}
	}
	if ep.URL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "url 必填"})
		return
	}
	start := time.Now()
	err := registry.Test(ep)
	lat := time.Since(start).Milliseconds()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"ok": false, "error": err.Error(), "latencyMs": lat})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "latencyMs": lat})
}

// UpdateRegistry 修改已有连接。
// 密码字段留空表示不修改（复用库中已有密文）；非空则重新加密落库。
func (h *Handler) UpdateRegistry(c *gin.Context) {
	cid, _ := h.clusterID(c)
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var body struct {
		Name        string `json:"name"`
		Type        string `json:"type"`
		URL         string `json:"url"`
		Username    string `json:"username"`
		Password    string `json:"password"`
		Namespace   string `json:"namespace"`
		InsecureTLS bool   `json:"insecureTls"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.URL == "" || body.Username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "url 与 username 必填"})
		return
	}
	if body.Type == "" {
		body.Type = "harbor"
	}
	// 密码：为空则保留库中现有密文（用 map 更新跳过 password 列，避免 BeforeSave 二次加密）；
	// 非空则手动加密后写入，同样不经模型的 BeforeSave 钩子。
	updates := map[string]interface{}{
		"name":         body.Name,
		"type":         body.Type,
		"url":          body.URL,
		"username":     body.Username,
		"namespace":    body.Namespace,
		"insecure_tls": body.InsecureTLS,
	}
	if body.Password != "" {
		enc, e := crypto.Encrypt(body.Password)
		if e != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "密码加密失败: " + e.Error()})
			return
		}
		updates["password"] = enc
	}
	if err := h.Store.DB.Model(&model.RegistryEndpoint{}).Where("id = ? AND cluster_id = ?", id, cid).Updates(updates).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// 回读最新记录（AfterFind 解密密码，供前端回填）
	var ep model.RegistryEndpoint
	if err := h.Store.DB.First(&ep, id).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditRegistryUpdate, "registry", ep.Name, cid, "ok", "url="+ep.URL+" type="+ep.Type)
	c.JSON(http.StatusOK, ep)
}

// RegistryProjects 列出某连接的项目（统一视图）
func (h *Handler) RegistryProjects(c *gin.Context) {
	id, err := strconv.ParseUint(c.Query("registry"), 10, 64)
	if err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少或无效的 registry 参数"})
		return
	}
	ckey := keyProjects(uint(id))
	if body, ok := h.regCache.get(ckey); ok {
		c.Data(http.StatusOK, "application/json; charset=utf-8", body)
		return
	}
	cli, _, err := h.loadRegistryClient(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ps, err := cli.ListProjects()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	body, _ := json.Marshal(ps)
	h.regCache.set(ckey, body)
	c.Data(http.StatusOK, "application/json; charset=utf-8", body)
}

// RegistryCreateProject 在某连接下创建项目（仅 Harbor 支持）
func (h *Handler) RegistryCreateProject(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Query("registry"), 10, 64)
	cli, _, err := h.loadRegistryClient(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var body struct {
		Name   string `json:"name"`
		Public bool   `json:"public"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name 必填"})
		return
	}
	code, err := cli.CreateProject(body.Name, body.Public)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	// 失效项目列表缓存（新建后下次拉才能看到）
	h.regCache.invalidatePrefix(keyPrefix(uint(id)))
	c.JSON(http.StatusOK, gin.H{"code": code, "name": body.Name})
}

// RegistryUpdateProject 修改某连接下项目的公开/私有属性（仅 Harbor 支持）。
func (h *Handler) RegistryUpdateProject(c *gin.Context) {
	cli, _, err := h.loadRegistryClient(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var body struct {
		Name   string `json:"name"`
		Public bool   `json:"public"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name 必填"})
		return
	}
	code, err := cli.UpdateProject(body.Name, body.Public)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": code, "name": body.Name, "public": body.Public})
}

// RegistryDeleteProject 删除某连接下的项目（仅 Harbor 支持）。
// 删除前校验：项目下仍有仓库（镜像）则拦截，避免误删导致 Harbor 412。
func (h *Handler) RegistryDeleteProject(c *gin.Context) {
	cli, ep, err := h.loadRegistryClient(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if ep.Type != "harbor" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "该仓库类型不支持通过 API 删除项目（仅 Harbor 支持）"})
		return
	}
	name := c.Query("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name 必填"})
		return
	}
	// 删除前校验：项目下是否还有仓库（镜像）
	rs, err := cli.ListRepositories(name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if len(rs) > 0 {
		c.JSON(http.StatusConflict, gin.H{
			"error": fmt.Sprintf("该项目下还有 %d 个仓库（镜像），无法删除。请先删除这些仓库内的镜像版本，再删除项目。", len(rs)),
		})
		return
	}
	code, err := cli.DeleteProject(name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	// 失效项目 / 仓库列表缓存（删除项目后必须立即可见）
	h.regCache.invalidatePrefix(keyPrefix(ep.ID))
	c.JSON(http.StatusOK, gin.H{"code": code, "name": name})
}

// RegistryRepos 列出某项目下的仓库（统一视图）
func (h *Handler) RegistryRepos(c *gin.Context) {
	id, err := strconv.ParseUint(c.Query("registry"), 10, 64)
	if err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少或无效的 registry 参数"})
		return
	}
	project := c.Query("project")
	if project == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "project 必填"})
		return
	}
	ckey := keyRepos(uint(id), project)
	if body, ok := h.regCache.get(ckey); ok {
		c.Data(http.StatusOK, "application/json; charset=utf-8", body)
		return
	}
	cli, _, err := h.loadRegistryClient(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	rs, err := cli.ListRepositories(project)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	body, _ := json.Marshal(rs)
	h.regCache.set(ckey, body)
	c.Data(http.StatusOK, "application/json; charset=utf-8", body)
}

// RegistryArtifacts 列出某仓库的制品（版本 + 漏洞，统一视图）
func (h *Handler) RegistryArtifacts(c *gin.Context) {
	id, err := strconv.ParseUint(c.Query("registry"), 10, 64)
	if err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少或无效的 registry 参数"})
		return
	}
	project := c.Query("project")
	repo := c.Query("repo")
	if project == "" || repo == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "project 与 repo 必填"})
		return
	}
	ckey := keyArtifacts(uint(id), project, repo)
	if body, ok := h.regCache.get(ckey); ok {
		c.Data(http.StatusOK, "application/json; charset=utf-8", body)
		return
	}
	cli, _, err := h.loadRegistryClient(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	as, err := cli.ListArtifacts(project, repo)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	body, _ := json.Marshal(as)
	h.regCache.set(ckey, body)
	c.Data(http.StatusOK, "application/json; charset=utf-8", body)
}

// RegistryProjectUsage 返回项目的实际存储用量（来自真实镜像体积，按 digest 去重累加）。
func (h *Handler) RegistryProjectUsage(c *gin.Context) {
	cli, _, err := h.loadRegistryClient(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	project := c.Query("project")
	if project == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "project 必填"})
		return
	}
	used, err := cli.ProjectUsage(project)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"used": used})
}

// RegistryDeleteArtifact 删除某个镜像版本（制品）。仅 Harbor 支持。
// 查询参数：?registry=&project=&repo=&ref=（ref 为 digest 或 tag）。
func (h *Handler) RegistryDeleteArtifact(c *gin.Context) {
	cli, ep, err := h.loadRegistryClient(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if ep.Type != "harbor" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "该仓库类型不支持通过 API 删除镜像（仅 Harbor 支持）"})
		return
	}
	project := c.Query("project")
	repo := c.Query("repo")
	ref := c.Query("ref")
	if project == "" || repo == "" || ref == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "project、repo、ref 均必填"})
		return
	}
	code, err := cli.DeleteArtifact(project, repo, ref)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	// 失效对应制品 / 仓库列表缓存（删除后必须立即可见）
	h.regCache.invalidatePrefix(keyPrefix(ep.ID))
	c.JSON(http.StatusOK, gin.H{"code": code, "project": project, "repo": repo, "ref": ref})
}

// RegistryDeleteRepository 删除整个仓库（镜像名）及其下全部版本。仅 Harbor 支持。
// 查询参数：?registry=&project=&repo=。
func (h *Handler) RegistryDeleteRepository(c *gin.Context) {
	cli, ep, err := h.loadRegistryClient(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if ep.Type != "harbor" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "该仓库类型不支持通过 API 删除仓库（仅 Harbor 支持）"})
		return
	}
	project := c.Query("project")
	repo := c.Query("repo")
	if project == "" || repo == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "project 与 repo 必填"})
		return
	}
	code, err := cli.DeleteRepository(project, repo)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	// 失效仓库列表缓存（删除后必须立即可见）
	h.regCache.invalidatePrefix(keyPrefix(ep.ID))
	c.JSON(http.StatusOK, gin.H{"code": code, "project": project, "repo": repo})
}
