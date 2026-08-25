package handler

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kubehelm/server/internal/repository"

	"github.com/gin-gonic/gin"
)

// Audit 审计日志列表（多维筛选 + 分页 + 导出）
//   ?actor=        模糊匹配操作人
//   ?action=       精确匹配（如 user.create）
//   ?resource=     模糊匹配 resource_name
//   ?resourceType= 精确匹配资源类型（user/role/cluster/...）
//   ?cluster=      cluster_id（数字）
//   ?result=       ok / denied / error
//   ?from=         RFC3339，起始时间（含）
//   ?to=           RFC3339，截止时间（不含）
//   ?limit=        默认 100，最大 500
//   ?offset=       默认 0
//   ?export=csv|json  触发导出（无 export= 走列表）
func (h *Handler) Audit(c *gin.Context) {
	if exp := c.Query("export"); exp != "" {
		h.auditExport(c, exp)
		return
	}
	f := repository.AuditFilter{
		ActorName:    c.Query("actor"),
		Action:       c.Query("action"),
		ResourceType: c.Query("resourceType"),
		ResourceName: c.Query("resource"),
		Result:       c.Query("result"),
	}
	if cid := c.Query("cluster"); cid != "" {
		if id, err := strconv.ParseUint(cid, 10, 64); err == nil {
			f.ClusterID = uint(id)
		}
	}
	if v := c.Query("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.From = t
		}
	}
	if v := c.Query("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.To = t
		}
	}
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Limit = n
		}
	}
	if v := c.Query("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Offset = n
		}
	}
	list, err := h.Store.AuditQuery(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	total, _ := h.Store.AuditCount(f)
	c.JSON(http.StatusOK, gin.H{"items": list, "total": total})
}

// auditExport 内部导出（从 Audit 通过 ?export= 路由进来）
func (h *Handler) auditExport(c *gin.Context, format string) {
	f := repository.AuditFilter{
		ActorName:    c.Query("actor"),
		Action:       c.Query("action"),
		ResourceType: c.Query("resourceType"),
		ResourceName: c.Query("resource"),
		Result:       c.Query("result"),
	}
	if cid := c.Query("cluster"); cid != "" {
		if id, err := strconv.ParseUint(cid, 10, 64); err == nil {
			f.ClusterID = uint(id)
		}
	}
	if v := c.Query("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.From = t
		}
	}
	if v := c.Query("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.To = t
		}
	}
	f.Limit = 500
	list, err := h.Store.AuditQuery(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	format = strings.ToLower(format)
	filename := fmt.Sprintf("audit_%d.csv", time.Now().Unix())
	if format == "json" {
		filename = fmt.Sprintf("audit_%d.jsonl", time.Now().Unix())
		c.Header("Content-Disposition", "attachment; filename="+filename)
		c.Header("Content-Type", "application/x-ndjson")
		for _, a := range list {
			line := fmt.Sprintf(`{"id":%d,"time":%q,"actorId":%d,"actorName":%q,"action":%q,"resourceType":%q,"resourceName":%q,"clusterId":%d,"result":%q,"ip":%q,"detail":%q}`+"\n",
				a.ID, a.Time.Format(time.RFC3339Nano), a.ActorID, a.ActorName,
				a.Action, a.ResourceType, a.ResourceName, a.ClusterID,
				a.Result, a.IP, a.Detail)
			c.Writer.WriteString(line)
		}
		return
	}
	c.Header("Content-Disposition", "attachment; filename="+filename)
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Writer.WriteString("\xEF\xBB\xBF")
	w := csv.NewWriter(c.Writer)
	w.Write([]string{"id", "time", "actorId", "actorName", "action", "resourceType", "resourceName", "clusterId", "result", "ip", "detail"})
	for _, a := range list {
		w.Write([]string{
			strconv.FormatUint(uint64(a.ID), 10),
			a.Time.Format(time.RFC3339Nano),
			strconv.FormatUint(uint64(a.ActorID), 10),
			a.ActorName,
			a.Action,
			a.ResourceType,
			a.ResourceName,
			strconv.FormatUint(uint64(a.ClusterID), 10),
			a.Result,
			a.IP,
			a.Detail,
		})
	}
	w.Flush()
}

// AuditDetail 单查详情
func (h *Handler) AuditDetail(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	a, err := h.Store.AuditByID(uint(id))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "audit log not found"})
		return
	}
	c.JSON(http.StatusOK, a)
}

// AuditSummary 聚合统计
func (h *Handler) AuditSummary(c *gin.Context) {
	s, err := h.Store.AuditComputeSummary()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, s)
}
