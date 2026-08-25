package middleware

import (
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"kubehelm/server/internal/model"
	"kubehelm/server/internal/repository"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func jwtSecret() []byte {
	s := os.Getenv("JWT_SECRET")
	if s == "" {
		s = "kubehelm-dev-secret-change-in-prod"
	}
	return []byte(s)
}

// GenerateToken 为指定用户签发 24h JWT。uid=0 时仅写 sub（向后兼容旧 token）。
func GenerateToken(username string, uid uint, role string) (string, error) {
	claims := jwt.MapClaims{
		"sub":  username,
		"iat":  time.Now().Unix(),
		"exp":  time.Now().Add(24 * time.Hour).Unix(),
		"uid":  uid,
		"role": role,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(jwtSecret())
}

// authPayload 写入 gin.Context 的当前用户身份
const (
	AuthKey          = "auth"
	AuthUserID       = "authUserID"
	AuthUsername     = "authUser"
	AuthPlatformRole = "authPlatformRole"
)

// JWT 校验中间件：把 uid/username/role 写入 ctx。旧 token（uid=0）按 username 反查 User 表回填。
func JWT(store *repository.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		tokenStr := ""
		if strings.HasPrefix(h, "Bearer ") {
			tokenStr = strings.TrimPrefix(h, "Bearer ")
		} else if q := c.Query("token"); q != "" {
			// 浏览器 WebSocket 握手无法设置自定义 header，允许通过 query 传递 token
			tokenStr = q
		}
		if tokenStr == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
			return
		}
		claims := jwt.MapClaims{}
		if _, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
			return jwtSecret(), nil
		}); err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
		username, _ := claims["sub"].(string)
		uidF, _ := claims["uid"].(float64)
		role, _ := claims["role"].(string)
		uid := uint(uidF)
		// 旧 token 回填：从 User 表按 username 拿
		if uid == 0 && username != "" && store != nil {
			if u, err := store.UserByName(username); err == nil {
				uid = u.ID
				if role == "" {
					role = u.Role
				}
			}
		}
		// 禁用用户拒绝
		if uid > 0 && store != nil {
			if u, err := store.UserByID(uid); err == nil && !u.Active {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "user disabled"})
				return
			}
		}
		c.Set(AuthUserID, uid)
		c.Set(AuthUsername, username)
		c.Set(AuthPlatformRole, role)
		if username == "admin" && role == "" {
			c.Set(AuthPlatformRole, model.RolePlatformAdmin) // 兜底：默认登录的 admin 视为平台管理员
		}
		c.Next()
	}
}

// helper: 从 ctx 取 uid
func UserID(c *gin.Context) uint {
	if v, ok := c.Get(AuthUserID); ok {
		if u, ok := v.(uint); ok {
			return u
		}
	}
	return 0
}

// helper: 从 ctx 取 username
func Username(c *gin.Context) string {
	if v, ok := c.Get(AuthUsername); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// helper: 从 ctx 取平台角色（slug）
func PlatformRole(c *gin.Context) string {
	if v, ok := c.Get(AuthPlatformRole); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// ParseClusterID 解析 ?cluster= query，允许数字或名称（兼容旧版本，按 cluster_id 数字优先）
func ParseClusterID(c *gin.Context) (uint, bool) {
	q := c.Query("cluster")
	if q == "" {
		return 0, false
	}
	if id, err := strconv.ParseUint(q, 10, 64); err == nil {
		return uint(id), true
	}
	// 名称形式：留给 handler 解析（需要 store），此处仅返回 0
	return 0, true
}
