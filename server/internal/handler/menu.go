package handler

import (
	"net/http"
	"strings"

	"kubehelm/server/internal/audit"
	"kubehelm/server/internal/middleware"
	"kubehelm/server/internal/model"

	"github.com/gin-gonic/gin"
)

// RoleMenuPermissions 列出某角色当前的全部可见菜单 key
// 注意：platform-admin 永远看全部菜单（middleware bypass 逻辑独立于此函数）
func (h *Handler) RoleMenuPermissions(c *gin.Context) {
	slug := c.Param("slug")
	if slug == model.RolePlatformAdmin {
		// platform-admin 始终返回全部
		c.JSON(http.StatusOK, model.AllMenuKeys())
		return
	}
	menus, err := h.Store.RoleMenus(slug)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if menus == nil {
		menus = []string{}
	}
	c.JSON(http.StatusOK, menus)
}

// SetRoleMenuPermissions 覆盖式设置某角色可见菜单
// platform-admin 禁止修改（直接返 400）
func (h *Handler) SetRoleMenuPermissions(c *gin.Context) {
	slug := c.Param("slug")
	if slug == model.RolePlatformAdmin {
		c.JSON(http.StatusBadRequest, gin.H{"error": "platform-admin 始终拥有所有菜单权限，不可修改"})
		return
	}
	var body struct {
		Menus []string `json:"menus"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// 校验 menu_key 都在白名单内
	allSet := make(map[string]bool, len(model.AllMenuKeys()))
	for _, m := range model.AllMenuKeys() {
		allSet[m] = true
	}
	for _, m := range body.Menus {
		if !allSet[m] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid menu key: " + m})
			return
		}
	}
	if err := h.Store.SetRoleMenus(slug, body.Menus); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditRoleMenuSet, "role", slug, 0, "ok",
		"menus="+strings.Join(body.Menus, ","))
	c.JSON(http.StatusOK, gin.H{"ok": true, "slug": slug, "menus": body.Menus})
}

// MyMenus 当前用户可见的菜单 key 列表
// platform-admin 全可见；其他用户按其 User.Role 查 menu_permissions 表
func (h *Handler) MyMenus(c *gin.Context) {
	role := middleware.PlatformRole(c)
	if role == model.RolePlatformAdmin {
		c.JSON(http.StatusOK, gin.H{"menus": model.AllMenuKeys(), "isPlatformAdmin": true})
		return
	}
	uid := middleware.UserID(c)
	if uid == 0 {
		c.JSON(http.StatusOK, gin.H{"menus": []string{}, "isPlatformAdmin": false})
		return
	}
	menus, err := h.Store.MyMenus(uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if menus == nil {
		menus = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"menus": menus, "isPlatformAdmin": false})
}