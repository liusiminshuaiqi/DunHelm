package k8s

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	"kubehelm/server/internal/model"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// ---------- 网络（Service + Ingress）真实集群读取 ----------
//
// 设计目标：让 DunHelm 网络页的数据完全来自真实 K8s 集群（不再走本地 DB mock）。
// Service 是 namespaced（core/v1），Ingress 是 namespaced（networking.k8s.io/v1）。
// 仅在用户已选真实集群（?cluster=<id>）时启用；未选集群或缺 KubeConfig 时返回错误，
// 让前端降级到 mock + 友好提示（与 Storage 页一致）。

// Services 列出集群所有 Service（跨命名空间）
func (m *Manager) Services(cid uint) ([]model.Service, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	list, err := cs.CoreV1().Services(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("列出 Service 失败: %w", err)
	}
	out := make([]model.Service, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, svcToModel(&list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

func svcToModel(svc *corev1.Service) model.Service {
	var ports []string
	for _, p := range svc.Spec.Ports {
		proto := string(p.Protocol)
		if proto == "" {
			proto = "TCP"
		}
		ports = append(ports, fmt.Sprintf("%d:%d/%s", p.Port, p.TargetPort.IntValue(), proto))
	}
	clusterIP := svc.Spec.ClusterIP
	if clusterIP == "" {
		clusterIP = "—"
	}
	status := "ok"
	if svc.Spec.Type == corev1.ServiceTypeLoadBalancer && len(svc.Status.LoadBalancer.Ingress) == 0 {
		status = "pending"
	}
	return model.Service{
		Name:       svc.Name,
		Namespace:  svc.Namespace,
		Type:       string(svc.Spec.Type),
		ClusterIP:  clusterIP,
		Ports:      strings.Join(ports, ", "),
		Selector:   joinLabels(svc.Spec.Selector),
		Annotations: joinLabels(svc.Annotations),
		Status:     status,
	}
}

// Ingresses 列出集群所有 Ingress（跨命名空间）
func (m *Manager) Ingresses(cid uint) ([]model.Ingress, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	list, err := cs.NetworkingV1().Ingresses(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("列出 Ingress 失败: %w", err)
	}
	out := make([]model.Ingress, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, ingToModel(&list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Host != out[j].Host {
			return out[i].Host < out[j].Host
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

func ingToModel(ing *networkingv1.Ingress) model.Ingress {
	host, path, backend := "—", "/", "—"
	tls := len(ing.Spec.TLS) > 0
	if len(ing.Spec.Rules) > 0 {
		r := ing.Spec.Rules[0]
		host = r.Host
		if r.HTTP != nil && len(r.HTTP.Paths) > 0 {
			p := r.HTTP.Paths[0]
			path = p.Path
			if p.Backend.Service != nil {
				backend = fmt.Sprintf("%s:%d", p.Backend.Service.Name, p.Backend.Service.Port.Number)
			}
		}
	}
	return model.Ingress{
		Name:      ing.Name,
		Namespace: ing.Namespace,
		Host:      host,
		Path:      path,
		Backend:   backend,
		Tls:       tls,
		Status:    "ok",
	}
}

// ---------- 创建 ----------

// CreateService 真实集群创建 Service
func (m *Manager) CreateService(cid uint, in model.ServiceInput) (*model.Service, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	if in.Name == "" || in.Namespace == "" {
		return nil, fmt.Errorf("名称与命名空间不能为空")
	}
	ports, err := buildServicePorts(in.Ports, nil)
	if err != nil {
		return nil, err
	}
	selector, err := parseSelector(in.Selector)
	if err != nil {
		return nil, err
	}
	svcType := corev1.ServiceType(in.Type)
	if svcType == "" {
		svcType = corev1.ServiceTypeClusterIP
	}
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      in.Name,
			Namespace: in.Namespace,
		},
		Spec: corev1.ServiceSpec{
			Type:     svcType,
			Selector: selector,
			Ports:    ports,
		},
	}
	created, err := cs.CoreV1().Services(in.Namespace).Create(ctx, svc, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("创建 Service 失败: %w", err)
	}
	out := svcToModel(created)
	return &out, nil
}

// CreateIngress 真实集群创建 Ingress
func (m *Manager) CreateIngress(cid uint, in model.IngressInput) (*model.Ingress, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	ns := in.Namespace
	if ns == "" {
		ns = "default"
	}
	if in.Host == "" {
		return nil, fmt.Errorf("域名(host)不能为空")
	}
	svcName, port, err := parseBackend(in.Backend)
	if err != nil {
		return nil, err
	}
	path := in.Path
	if path == "" {
		path = "/"
	}
	pathType := networkingv1.PathTypePrefix
	ingClass := in.IngressClass
	if ingClass == "" {
		ingClass = "nginx"
	}
	ing := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ingName(in.Host),
			Namespace: ns,
		},
		Spec: networkingv1.IngressSpec{
			IngressClassName: &ingClass,
			Rules: []networkingv1.IngressRule{{
				Host: in.Host,
				IngressRuleValue: networkingv1.IngressRuleValue{
					HTTP: &networkingv1.HTTPIngressRuleValue{
						Paths: []networkingv1.HTTPIngressPath{{
							Path:     path,
							PathType: &pathType,
							Backend: networkingv1.IngressBackend{
								Service: &networkingv1.IngressServiceBackend{
									Name: svcName,
									Port: networkingv1.ServiceBackendPort{Number: int32(port)},
								},
							},
						}},
					},
				},
			}},
		},
	}
	if in.TLS {
		tls := networkingv1.IngressTLS{Hosts: []string{in.Host}}
		if in.SecretName != "" {
			tls.SecretName = in.SecretName
		}
		ing.Spec.TLS = []networkingv1.IngressTLS{tls}
	}
	created, err := cs.NetworkingV1().Ingresses(ns).Create(ctx, ing, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("创建 Ingress 失败: %w", err)
	}
	out := ingToModel(created)
	return &out, nil
}

// ---------- 删除 ----------

func (m *Manager) DeleteService(cid uint, ns, name string) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	ctx := context.TODO()
	if err := cs.CoreV1().Services(ns).Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		if apierr.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("删除 Service 失败: %w", err)
	}
	return nil
}

func (m *Manager) DeleteIngress(cid uint, ns, name string) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	ctx := context.TODO()
	if err := cs.NetworkingV1().Ingresses(ns).Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		if apierr.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("删除 Ingress 失败: %w", err)
	}
	return nil
}

// ---------- 修改 ----------

// UpdateService 修改 Service 的可变字段：selector / annotations / type / ports
// 注意：spec.ports 与 spec.type 在 K8s 中均可变；仅 clusterIP 与已分配的 nodePort 不可变。
// 因此更新端口时按 Port 匹配原端口、保留其 nodePort，避免 immutable 报错。
func (m *Manager) UpdateService(cid uint, ns, name string, up model.ServiceUpdate) (*model.Service, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	svc, err := cs.CoreV1().Services(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("获取 Service 失败: %w", err)
	}
	if up.Type != "" {
		svc.Spec.Type = corev1.ServiceType(up.Type)
	}
	if len(up.Ports) > 0 {
		newPorts, err := buildServicePorts(up.Ports, svc.Spec.Ports)
		if err != nil {
			return nil, err
		}
		svc.Spec.Ports = newPorts
	}
	if len(up.Selector) > 0 {
		svc.Spec.Selector = up.Selector
	}
	if len(up.Annotations) > 0 {
		if svc.Annotations == nil {
			svc.Annotations = map[string]string{}
		}
		for k, v := range up.Annotations {
			svc.Annotations[k] = v
		}
	}
	updated, err := cs.CoreV1().Services(ns).Update(ctx, svc, metav1.UpdateOptions{})
	if err != nil {
		return nil, fmt.Errorf("更新 Service 失败: %w", err)
	}
	out := svcToModel(updated)
	return &out, nil
}

// UpdateIngress 修改 Ingress 的 path / backend / tls（保留 host）
func (m *Manager) UpdateIngress(cid uint, ns, name string, up model.IngressUpdate) (*model.Ingress, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	ing, err := cs.NetworkingV1().Ingresses(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("获取 Ingress 失败: %w", err)
	}
	svcName, port, err := parseBackend(up.Backend)
	if err != nil {
		return nil, err
	}
	path := up.Path
	if path == "" {
		path = "/"
	}
	pathType := networkingv1.PathTypePrefix
	host := ""
	if len(ing.Spec.Rules) > 0 {
		host = ing.Spec.Rules[0].Host
	}
	ing.Spec.Rules = []networkingv1.IngressRule{{
		Host: host,
		IngressRuleValue: networkingv1.IngressRuleValue{
			HTTP: &networkingv1.HTTPIngressRuleValue{
				Paths: []networkingv1.HTTPIngressPath{{
					Path:     path,
					PathType: &pathType,
					Backend: networkingv1.IngressBackend{
						Service: &networkingv1.IngressServiceBackend{
							Name: svcName,
							Port: networkingv1.ServiceBackendPort{Number: int32(port)},
						},
					},
				}},
			},
		},
	}}
	if up.TLS {
		tls := networkingv1.IngressTLS{Hosts: []string{host}}
		if up.SecretName != "" {
			tls.SecretName = up.SecretName
		}
		ing.Spec.TLS = []networkingv1.IngressTLS{tls}
	} else {
		ing.Spec.TLS = nil
	}
	updated, err := cs.NetworkingV1().Ingresses(ns).Update(ctx, ing, metav1.UpdateOptions{})
	if err != nil {
		return nil, fmt.Errorf("更新 Ingress 失败: %w", err)
	}
	out := ingToModel(updated)
	return &out, nil
}

// ---------- 解析辅助 ----------

// buildServicePorts 把结构化端口入参转成 corev1.ServicePort。
// 创建时 existing 传 nil；更新时传当前 svc.Spec.Ports，按 Port 匹配以保留已分配的 nodePort
// （nodePort 不可变，若不匹配则交由 K8s 重新分配）。端口名：未提供时按 协议-端口 自动生成，
// 满足 K8s「多端口必须命名」的约束。
func buildServicePorts(in []model.ServicePortInput, existing []corev1.ServicePort) ([]corev1.ServicePort, error) {
	if len(in) == 0 {
		return nil, fmt.Errorf("至少需要一个端口映射")
	}
	out := make([]corev1.ServicePort, 0, len(in))
	for i := range in {
		p := in[i]
		if p.Port <= 0 {
			return nil, fmt.Errorf("服务端口必须大于 0")
		}
		tp := p.TargetPort
		if tp <= 0 {
			tp = p.Port
		}
		proto := corev1.ProtocolTCP
		switch strings.ToUpper(strings.TrimSpace(p.Protocol)) {
		case "UDP":
			proto = corev1.ProtocolUDP
		case "SCTP":
			proto = corev1.ProtocolSCTP
		default:
			proto = corev1.ProtocolTCP
		}
		name := strings.TrimSpace(p.Name)
		if name == "" {
			name = fmt.Sprintf("%s-%d", strings.ToLower(string(proto)), p.Port)
		}
		sp := corev1.ServicePort{
			Name:       name,
			Port:       int32(p.Port),
			TargetPort: intstr.FromInt(tp),
			Protocol:   proto,
		}
		// 更新时按 Port 匹配原端口，保留 nodePort（不可变）与已有名称
		for j := range existing {
			if existing[j].Port == int32(p.Port) {
				sp.NodePort = existing[j].NodePort
				if strings.TrimSpace(p.Name) == "" && existing[j].Name != "" {
					sp.Name = existing[j].Name
				}
				break
			}
		}
		out = append(out, sp)
	}
	return out, nil
}

func parseSelector(s string) (map[string]string, error) {
	m := map[string]string{}
	s = strings.TrimSpace(s)
	if s == "" {
		return m, nil
	}
	for _, kv := range strings.Split(s, ",") {
		kv = strings.TrimSpace(kv)
		if kv == "" {
			continue
		}
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" {
			return nil, fmt.Errorf("selector 格式错误: %s（应为 key=value）", kv)
		}
		m[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
	}
	return m, nil
}

func parseBackend(s string) (string, int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", 0, fmt.Errorf("后端服务不能为空")
	}
	parts := strings.SplitN(s, ":", 2)
	name := parts[0]
	port := 80
	if len(parts) == 2 {
		p, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil {
			return "", 0, fmt.Errorf("后端端口格式错误: %w", err)
		}
		port = p
	}
	if name == "" {
		return "", 0, fmt.Errorf("后端服务名不能为空")
	}
	return name, port, nil
}

// ingName 把 host 转成合法的 Ingress 对象名（DNS subdomain，允许点/短横，不允许大写）
func ingName(host string) string {
	h := strings.ToLower(host)
	h = strings.ReplaceAll(h, "*", "wild")
	h = strings.ReplaceAll(h, ".", "-")
	if h == "" {
		h = "ingress"
	}
	return h
}

// tlsSecretName 由 host 派生合法 DNS label（≤63 字符，仅小写字母数字与 -，首末为字母数字）。
// 例：demo.dunhelm.io → tls-demo-dunhelm-io
func tlsSecretName(host string) string {
	s := strings.ToLower(strings.TrimSpace(host))
	s = strings.ReplaceAll(s, "*", "wild")
	var b strings.Builder
	b.WriteString("tls-")
	for _, r := range strings.ReplaceAll(s, ".", "-") {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			b.WriteRune(r)
		default:
			// 其它字符（下划线/中文等）统一折叠为 -
			b.WriteRune('-')
		}
	}
	name := b.String()
	name = strings.Trim(name, "-")
	name = strings.ReplaceAll(name, "--", "-")
	if name == "" {
		name = "tls-ingress"
	}
	if len(name) > 63 {
		name = name[:63]
		name = strings.Trim(name, "-")
	}
	return name
}

// GenerateIngressTLS 为给定 host 生成一张自签名证书，并以 kubernetes.io/tls Secret 形式
// 落进目标命名空间（ns 为空时回退 default）。返回创建的 Secret 名，调用方可直接作为
// Ingress TLS SecretName 使用，同时把该凭证登记进「代码凭证」库（由 handler 完成）。
func (m *Manager) GenerateIngressTLS(cid uint, ns string, host string) (string, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return "", err
	}
	ctx := context.TODO()
	if ns == "" {
		ns = "default"
	}
	if host == "" {
		return "", fmt.Errorf("域名(host)不能为空")
	}

	// 1) 生成 RSA 私钥
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", fmt.Errorf("生成私钥失败: %w", err)
	}
	// 2) 构造证书模板
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return "", fmt.Errorf("生成序列号失败: %w", err)
	}
	now := time.Now()
	tmpl := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: host, Organization: []string{"DunHelm"}},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(3650 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{host},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return "", fmt.Errorf("生成证书失败: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})

	// 3) 派生合法 Secret 名（重名时加短后缀）
	secretName := tlsSecretName(host)
	for i := 1; i <= 9; i++ {
		_, gerr := cs.CoreV1().Secrets(ns).Get(ctx, secretName, metav1.GetOptions{})
		if gerr != nil {
			if apierr.IsNotFound(gerr) {
				break
			}
			return "", fmt.Errorf("检查 Secret 失败: %w", gerr)
		}
		// 已存在：加后缀重试
		suffix := fmt.Sprintf("-%d", i)
		candidate := secretName
		if len(candidate)+len(suffix) > 63 {
			candidate = candidate[:63-len(suffix)]
		}
		secretName = candidate + suffix
	}

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      secretName,
			Namespace: ns,
		},
		Type: corev1.SecretTypeTLS,
		Data: map[string][]byte{
			"tls.crt": certPEM,
			"tls.key": keyPEM,
		},
	}
	if _, err := cs.CoreV1().Secrets(ns).Create(ctx, secret, metav1.CreateOptions{}); err != nil {
		return "", fmt.Errorf("创建 TLS Secret 失败: %w", err)
	}
	return secretName, nil
}

// joinLabels map → "k=v,k2=v2"（供前端展示 selector）
func joinLabels(m map[string]string) string {
	if len(m) == 0 {
		return ""
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+m[k])
	}
	return strings.Join(parts, ",")
}
