package k8s

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"kubehelm/server/internal/model"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Credentials 读取真实集群中所有命名空间的 Secret，并映射为「代码凭证」视图。
// 仅保留"凭据类" Secret，过滤掉系统级 Secret（service-account-token / bootstrap token 等），
// 避免凭证页被无关 Secret 淹没。
func (m *Manager) Credentials(cid uint) ([]model.Credential, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	list, err := cs.CoreV1().Secrets(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("列举 Secret 失败: %w", err)
	}
	out := make([]model.Credential, 0, len(list.Items))
	for i := range list.Items {
		sec := &list.Items[i]
		if !isCredentialSecret(sec) {
			continue
		}
		out = append(out, secretToCredential(sec))
	}
	return out, nil
}

// CreateCredentialSecret 在真实集群指定命名空间创建一条凭据 Secret。
// 按 Type 选择 K8s Secret 类型与 data 键，并打 dunhelm.io/cred-type 注解以便回读时稳定映射类型。
func (m *Manager) CreateCredentialSecret(cid uint, in model.CredentialInput) (*model.Credential, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	ns := in.Namespace
	if ns == "" {
		ns = "default"
	}
	if in.Name == "" {
		return nil, fmt.Errorf("凭证名称不能为空")
	}

	secretType, data, err := buildSecretPayload(in)
	if err != nil {
		return nil, err
	}

	createdBy := in.CreatedBy
	if createdBy == "" {
		createdBy = "admin"
	}
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      in.Name,
			Namespace: ns,
			Annotations: map[string]string{
				"dunhelm.io/cred-type": in.Type,
				"dunhelm.io/created-by": createdBy,
				"managed-by":            "DunHelm",
			},
		},
		Type: secretType,
		Data: data,
	}
	if _, err := cs.CoreV1().Secrets(ns).Create(ctx, secret, metav1.CreateOptions{}); err != nil {
		return nil, fmt.Errorf("创建 Secret 失败: %w", err)
	}
	c := secretToCredential(secret)
	c.Scope = in.Scope
	if c.Scope == "" {
		c.Scope = scopeFromNs(ns)
	}
	return &c, nil
}

// DeleteCredentialSecret 删除真实集群中的凭据 Secret（按命名空间 + 名称）。
func (m *Manager) DeleteCredentialSecret(cid uint, ns, name string) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	ctx := context.TODO()
	if ns == "" {
		ns = "default"
	}
	if err := cs.CoreV1().Secrets(ns).Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		return fmt.Errorf("删除 Secret 失败: %w", err)
	}
	return nil
}

// GetSecretData 读取真实集群中指定 Secret 的明文 data（已自动 base64 解码）。
// 用于「代码凭证」模式把保存的 token / 用户名解析出来做 git 鉴权。
func (m *Manager) GetSecretData(cid uint, ns, name string) (map[string][]byte, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	if ns == "" {
		ns = "default"
	}
	sec, err := cs.CoreV1().Secrets(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("读取 Secret %s/%s 失败: %w", ns, name, err)
	}
	return sec.Data, nil
}

// ---------- 内部辅助 ----------

const (
	annCredType  = "dunhelm.io/cred-type"
	annCreatedBy = "dunhelm.io/created-by"
)

// isCredentialSecret 判断一个 Secret 是否属于"代码凭证"范畴。
func isCredentialSecret(sec *corev1.Secret) bool {
	switch sec.Type {
	case corev1.SecretTypeTLS,
		corev1.SecretTypeDockerConfigJson,
		corev1.SecretTypeSSHAuth,
		corev1.SecretTypeBasicAuth:
		return true
	case corev1.SecretTypeServiceAccountToken,
		"kubernetes.io/token",
		"bootstrap.kubernetes.io/token",
		"helm.sh/release.v1":
		return false
	default:
		// Opaque：仅当带有 dunhelm.io/cred-type 注解（我们创建的）或含 kubeconfig 键时才视为凭证，
		// 其余应用配置类 Opaque 不纳入凭证页。
		if _, ok := sec.Annotations[annCredType]; ok {
			return true
		}
		if _, ok := sec.Data["kubeconfig"]; ok {
			return true
		}
		return false
	}
}

// credType 推导 UI 展示用的凭证类型；优先读注解，否则按 K8s Secret 类型推断。
func credType(sec *corev1.Secret) string {
	if t, ok := sec.Annotations[annCredType]; ok && t != "" {
		return t
	}
	switch sec.Type {
	case corev1.SecretTypeTLS:
		return "TLS"
	case corev1.SecretTypeDockerConfigJson:
		return "Harbor"
	case corev1.SecretTypeSSHAuth:
		return "SSH"
	case corev1.SecretTypeBasicAuth:
		return "GitHub"
	default:
		if _, ok := sec.Data["kubeconfig"]; ok {
			return "KubeConfig"
		}
		return "GitHub"
	}
}

func scopeFromNs(ns string) string {
	if ns == "default" || ns == "kube-system" {
		return "全局"
	}
	return ns
}

func secretToCredential(sec *corev1.Secret) model.Credential {
	createdBy := sec.Annotations[annCreatedBy]
	if createdBy == "" {
		createdBy = "集群"
	}
	status := "ok"
	if len(sec.Data) == 0 {
		status = "warn"
	}
	return model.Credential{
		Name:      sec.Name,
		Type:      credType(sec),
		Scope:     scopeFromNs(sec.Namespace),
		SecretRef: "secret/" + sec.Name,
		CreatedBy: createdBy,
		LastUsed:  "-",
		Status:    status,
		Namespace: sec.Namespace,
	}
}

// buildSecretPayload 按凭证类型构造 K8s Secret 的类型与 data（明文 → base64）。
func buildSecretPayload(in model.CredentialInput) (corev1.SecretType, map[string][]byte, error) {
	switch in.Type {
	case "TLS":
		if in.Data["cert"] == "" || in.Data["key"] == "" {
			return "", nil, fmt.Errorf("TLS 凭证需提供证书(cert)与私钥(key)")
		}
		return corev1.SecretTypeTLS, map[string][]byte{
			"tls.crt": []byte(in.Data["cert"]),
			"tls.key": []byte(in.Data["key"]),
		}, nil
	case "Harbor", "Docker Hub":
		if in.Data["username"] == "" || in.Data["password"] == "" {
			return "", nil, fmt.Errorf("镜像仓库凭证需提供用户名与密码")
		}
		registry := in.Data["registry"]
		if registry == "" {
			if in.Type == "Docker Hub" {
				registry = "https://index.docker.io/v1/"
			} else {
				return "", nil, fmt.Errorf("Harbor 凭证需填写镜像仓库地址(registry)")
			}
		}
		auth := base64.StdEncoding.EncodeToString([]byte(in.Data["username"] + ":" + in.Data["password"]))
		cfg := map[string]any{
			"auths": map[string]any{
				registry: map[string]string{
					"username": in.Data["username"],
					"password": in.Data["password"],
					"auth":     auth,
				},
			},
		}
		b, err := json.Marshal(cfg)
		if err != nil {
			return "", nil, fmt.Errorf("构造 dockerconfigjson 失败: %w", err)
		}
		return corev1.SecretTypeDockerConfigJson, map[string][]byte{
			".dockerconfigjson": b,
		}, nil
	case "SSH":
		if in.Data["privateKey"] == "" {
			return "", nil, fmt.Errorf("SSH 凭证需提供私钥")
		}
		return corev1.SecretTypeSSHAuth, map[string][]byte{
			"ssh-privatekey": []byte(in.Data["privateKey"]),
		}, nil
	case "KubeConfig":
		if in.Data["kubeconfig"] == "" {
			return "", nil, fmt.Errorf("KubeConfig 凭证需提供 kubeconfig 内容")
		}
		return corev1.SecretTypeOpaque, map[string][]byte{
			"kubeconfig": []byte(in.Data["kubeconfig"]),
		}, nil
	default: // GitHub / GitLab / Gitee 等 git 类 -> basic-auth
		if in.Data["token"] == "" {
			return "", nil, fmt.Errorf("Git 凭证需提供 Token")
		}
		return corev1.SecretTypeBasicAuth, map[string][]byte{
			"username": []byte(in.Data["username"]),
			"password": []byte(in.Data["token"]),
		}, nil
	}
}
