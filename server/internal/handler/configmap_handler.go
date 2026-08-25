package handler

import (
	"fmt"
	"net/http"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// ConfigMaps 列出某集群某 namespace 下的所有 ConfigMap（轻量摘要）。
//   GET /api/configmaps?cluster=<id>&namespace=<ns>
// 返回 {namespace, items: [{name, keyCount, dataBytes}, ...]}。
func (h *Handler) ConfigMaps(c *gin.Context) {
	cid, ok := h.parseClusterID(c)
	if !ok {
		return
	}
	ns := c.Query("namespace")
	if ns == "" {
		ns = "default"
	}
	items, err := h.K8s.ListConfigMaps(cid, ns)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("list configmaps: %v", err)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"namespace": ns, "items": items})
}

// ConfigMap 读取指定 ConfigMap 的完整内容（data + binaryData + labels + annotations）。
//   GET /api/configmaps/get?cluster=<id>&namespace=<ns>&name=<n>
func (h *Handler) ConfigMap(c *gin.Context) {
	cid, ok := h.parseClusterID(c)
	if !ok {
		return
	}
	ns := c.Query("namespace")
	name := c.Query("name")
	if ns == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace 与 name 必填"})
		return
	}
	view, err := h.K8s.GetConfigMap(cid, ns, name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("get configmap: %v", err)})
		return
	}
	c.JSON(http.StatusOK, view)
}

// ConfigMapUpdate 整体覆盖指定 ConfigMap 的 data 字段。
//   PUT /api/configmaps/update?cluster=<id>&namespace=<ns>&name=<n>
//   body: {"data": {"key1":"value1", ...}}
// labels / annotations / binaryData 保持原样；写空 {} 等价于清空 data。
func (h *Handler) ConfigMapUpdate(c *gin.Context) {
	cid, ok := h.parseClusterID(c)
	if !ok {
		return
	}
	ns := c.Query("namespace")
	name := c.Query("name")
	if ns == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace 与 name 必填"})
		return
	}
	var body struct {
		Data map[string]string `json:"data"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "body 必须是 JSON：{data: {key: value}}"})
		return
	}
	if body.Data == nil {
		body.Data = map[string]string{}
	}
	// 简单序列化预检（防止非 UTF-8 / 控制字符）：data key/value 必须是合法 UTF-8
	for k, v := range body.Data {
		if !utf8.ValidString(k) || !utf8.ValidString(v) {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("data[%q] 不是合法 UTF-8（ConfigMap 只支持文本 data，二进制请用 binaryData）", k)})
			return
		}
	}
	view, err := h.K8s.UpsertConfigMap(cid, ns, name, body.Data, nil, nil)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("update configmap: %v", err)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "view": view})
}

// parseClusterID 抽出 ?cluster=<id> 并转 uint；缺/非数字返 400。
func (h *Handler) parseClusterID(c *gin.Context) (uint, bool) {
	var cid uint
	if v := c.Query("cluster"); v != "" {
		if _, err := fmt.Sscanf(v, "%d", &cid); err != nil || cid == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的 cluster 参数"})
			return 0, false
		}
	} else {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 cluster 参数"})
		return 0, false
	}
	return cid, true
}