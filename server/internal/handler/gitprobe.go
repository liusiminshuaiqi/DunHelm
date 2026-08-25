package handler

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"strings"
	"time"

	"kubehelm/server/internal/model"

	"github.com/gin-gonic/gin"
)

// GitProbe 检测 Git 仓库连通性并列出分支，供前端「镜像构建」类流水线节点选择分支。
// 支持三种鉴权方式：
//   - none：匿名（仅公开仓库）
//   - password：账号 + 密码 / Token（直接嵌入 clone URL）
//   - credential：代码凭证名（从已连接集群的 K8s Secret 解析 username/password/token）
func (h *Handler) GitProbe(c *gin.Context) {
	var in struct {
		Repo       string `json:"repo"`
		AuthMode   string `json:"authMode"`
		Username   string `json:"username"`
		Password   string `json:"password"`
		Credential string `json:"credential"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	repo := strings.TrimSpace(in.Repo)
	if repo == "" {
		c.JSON(400, gin.H{"error": "仓库地址不能为空"})
		return
	}
	cloneURL, err := h.buildGitAuthURL(repo, in.AuthMode, strings.TrimSpace(in.Username), in.Password, strings.TrimSpace(in.Credential))
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	branches, perr := gitListBranches(cloneURL, 25*time.Second)
	if perr != nil {
		c.JSON(200, gin.H{"ok": false, "branches": []string{}, "error": perr.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "branches": branches, "error": ""})
}

// buildGitAuthURL 按鉴权方式把账号密码 / 凭证 token 嵌入 clone URL。
func (h *Handler) buildGitAuthURL(repo, authMode, username, password, credName string) (string, error) {
	repo = strings.TrimSpace(repo)
	// SSH 形式：交给本地 SSH agent / 私钥，不拼接账号密码
	if strings.HasPrefix(repo, "git@") || strings.HasPrefix(repo, "ssh://") {
		return repo, nil
	}
	base := repo
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "https://" + base
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("仓库地址解析失败: %w", err)
	}
	switch authMode {
	case "password":
		if username != "" {
			u.User = url.UserPassword(username, password)
		} else if password != "" {
			// 仅填密码（多为 Personal Access Token）：作为用户名嵌入（GitHub PAT 即此形式）
			u.User = url.User(password)
		}
		return u.String(), nil
	case "credential":
		if credName == "" {
			return "", fmt.Errorf("凭证模式需填写「代码凭证名」")
		}
		user, pass, cerr := h.resolveCredentialSecret(credName)
		if cerr != nil {
			return "", cerr
		}
		u.User = url.UserPassword(user, pass)
		return u.String(), nil
	default:
		// none / 其它：匿名
		return base, nil
	}
}

// resolveCredentialSecret 从已连接集群的 K8s Secret 解析出 git 鉴权所需的用户名 / 密码（token）。
func (h *Handler) resolveCredentialSecret(name string) (string, string, error) {
	cid, ok := h.firstConnectedCluster()
	if !ok {
		return "", "", fmt.Errorf("凭证模式需先在「集群」中配置真实 KubeConfig 才能解析密钥")
	}
	list, err := h.K8s.Credentials(cid)
	if err != nil {
		return "", "", fmt.Errorf("列举集群凭证失败: %w", err)
	}
	var target *model.Credential
	for i := range list {
		if list[i].Name == name {
			target = &list[i]
			break
		}
	}
	if target == nil {
		return "", "", fmt.Errorf("未在集群中找到名为 %q 的代码凭证", name)
	}
	data, err := h.K8s.GetSecretData(cid, target.Namespace, target.Name)
	if err != nil {
		return "", "", err
	}
	user := string(data["username"])
	pass := string(data["password"])
	if pass == "" {
		pass = string(data["token"])
	}
	if pass == "" {
		return "", "", fmt.Errorf("凭证 %q 不含 username/password/token 字段，无法用于 git 鉴权", name)
	}
	if user == "" {
		user = "git"
	}
	return user, pass, nil
}

// firstConnectedCluster 返回第一个 KubeConfig 非空且能成功建连的集群 id。
func (h *Handler) firstConnectedCluster() (uint, bool) {
	list, err := h.Store.Clusters()
	if err != nil || len(list) == 0 {
		return 0, false
	}
	for i := range list {
		if list[i].KubeConfig == "" {
			continue
		}
		if _, cerr := h.K8s.Clientset(list[i].ID); cerr == nil {
			return list[i].ID, true
		}
	}
	return 0, false
}

// gitListBranches 运行 `git ls-remote --heads` 解析出远端分支名列表。
func gitListBranches(cloneURL string, timeout time.Duration) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "ls-remote", "--heads", cloneURL)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		// git 报错里可能回显带密码的 URL，做脱敏处理
		msg = maskGitURL(msg, cloneURL)
		return nil, fmt.Errorf("git ls-remote 失败: %s", msg)
	}
	branches := []string{}
	const prefix = "\trefs/heads/"
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if idx := strings.Index(line, prefix); idx >= 0 {
			branches = append(branches, line[idx+len(prefix):])
		}
	}
	if len(branches) == 0 {
		return nil, fmt.Errorf("未检测到任何分支（仓库可能为空或无读取权限）")
	}
	return branches, nil
}

// maskGitURL 把消息中出现的明文带密码 URL 替换为脱敏形式（避免密码泄漏到日志/前端）。
func maskGitURL(msg, raw string) string {
	if !strings.Contains(raw, "@") {
		return msg
	}
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return msg
	}
	masked := u.Scheme + "://***:***@" + u.Host + u.Path
	return strings.ReplaceAll(msg, raw, masked)
}
