package middleware

import (
	"net/http"
	"strconv"

	"kubehelm/server/internal/audit"
	"kubehelm/server/internal/model"
	"kubehelm/server/internal/repository"

	"github.com/gin-gonic/gin"
)

// RequireClusterAccess 校验当前用户对 ?cluster= 的访问权限。
// 平台管理员 bypass；其他用户必须在 UserClusterPermission 中有该 cluster_id 的记录。
// 调用后从 ctx 取 clusterID 即可。
func RequireClusterAccess(store *repository.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		role := PlatformRole(c)
		// 平台管理员：所有集群全放行
		if role == model.RolePlatformAdmin {
			cid, _ := ParseClusterID(c)
			if cid > 0 {
				c.Set("clusterID", cid)
			}
			c.Next()
			return
		}
		uid := UserID(c)
		if uid == 0 {
			recordForbidden(store, c, "user", "0", 0, "unknown user")
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "unknown user", "code": "FORBIDDEN"})
			return
		}
		cid, hasQ := ParseClusterID(c)
		if !hasQ || cid == 0 {
			// 资源类接口必须带 cluster
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "cluster required (?cluster=ID)", "code": "CLUSTER_REQUIRED"})
			return
		}
		_, err := store.UserPermissionByCluster(uid, cid)
		if err != nil {
			recordForbidden(store, c, "cluster", "id="+strconv.FormatUint(uint64(cid), 10), cid,
				"no access to cluster #"+strconv.FormatUint(uint64(cid), 10))
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": "no access to cluster #" + strconv.FormatUint(uint64(cid), 10),
				"code":  "FORBIDDEN",
			})
			return
		}
		c.Set("clusterID", cid)
		c.Next()
	}
}

// RequireRole 校验当前用户拥有任一指定角色（slug 形式）
func RequireRole(slugs ...string) gin.HandlerFunc {
	want := make(map[string]bool, len(slugs))
	for _, s := range slugs {
		want[s] = true
	}
	return func(c *gin.Context) {
		role := PlatformRole(c)
		if !want[role] {
			recordForbidden(nil, c, "platform", "admin-only", 0, "role="+role+" required")
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "role required: " + role, "code": "FORBIDDEN"})
			return
		}
		c.Next()
	}
}

// recordForbidden 写一条 denied 审计（同步阻塞但 store.CreateAuditLog 已极快）
func recordForbidden(store *repository.Store, c *gin.Context, rType string, rName string, cid uint, detail string) {
	if store == nil {
		return
	}
	audit.RecordFromCtx(c, store, audit.ActorFrom(c), model.AuditForbidden, rType, rName, cid, "denied", detail)
}