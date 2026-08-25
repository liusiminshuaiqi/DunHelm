// Package audit 提供全局审计日志写入工具。
// 设计：handler 在关键操作完成后显式调用RecordFromCtx(c, store, ...)，
// 由 handler 负责从 gin.Context 抽 actor（通过 middleware helper），本包仅写存储。
// 不依赖 internal/middleware，避免循环依赖。
package audit

import (
	"log"
	"time"

	"kubehelm/server/internal/model"
	"kubehelm/server/internal/repository"

	"github.com/gin-gonic/gin"
)

// Actor 从 gin.Context 抽出来的身份信息（由 handler 通过 middleware helper 获取后传入）
type Actor struct {
	ID   uint
	Name string
}

// RecordFromCtx 自动从 c 提取 actor/ip/ua 并写入。失败仅日志不影响主流程。
func RecordFromCtx(
	c *gin.Context, store *repository.Store,
	actor Actor,
	action string, resourceType string, resourceName string,
	clusterID uint, result string, detail string,
) {
	if store == nil {
		return
	}
	if actor.Name == "" {
		actor.Name = "anonymous"
	}
	ip := c.ClientIP()
	ua := c.Request.UserAgent()

	logEntry := &model.AuditLog{
		Time:         time.Now(),
		ActorID:      actor.ID,
		ActorName:    actor.Name,
		Action:       action,
		ResourceType: resourceType,
		ResourceName: resourceName,
		ClusterID:    clusterID,
		Result:       result,
		Detail:       detail,
		IP:           ip,
		UserAgent:    ua,
	}
	if err := store.CreateAuditLog(logEntry); err != nil {
		log.Printf("[audit] write failed: %v", err)
	}
}

// Record 平台内部事件（无 gin ctx）。
func Record(store *repository.Store, actorName string, action string, resourceType string, resourceName string, detail string) {
	if store == nil {
		return
	}
	_ = store.CreateAuditLog(&model.AuditLog{
		Time:         time.Now(),
		ActorID:      0,
		ActorName:    actorName,
		Action:       action,
		ResourceType: resourceType,
		ResourceName: resourceName,
		ClusterID:    0,
		Result:       "ok",
		Detail:       detail,
		IP:           "system",
		UserAgent:    "internal",
	})
}

// ActorFrom 从 gin.Context 取 actor（包装 middleware helper，本包不依赖 middleware）
func ActorFrom(c *gin.Context) Actor {
	if v, ok := c.Get("authUserID"); ok {
		if u, ok := v.(uint); ok {
			if v2, ok2 := c.Get("authUser"); ok2 {
				if s, ok3 := v2.(string); ok3 {
					return Actor{ID: u, Name: s}
				}
			}
		}
	}
	return Actor{ID: 0, Name: ""}
}