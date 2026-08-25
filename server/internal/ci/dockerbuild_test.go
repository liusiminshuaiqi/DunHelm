package ci

import (
	"strings"
	"testing"
)

func TestDockerBuildHeredocSingleLine(t *testing.T) {
	e := &Engine{} // store/k8s nil：dockerBuildSteps 在显式 registry/project/imageName/version 时不依赖它们
	cfg := `{"dockerfileContent":"FROM openjdk:17\nWORKDIR /home\nCOPY target/*.jar /home\nENTRYPOINT java -jar app.jar","context":"payment/","imageName":"payment-api-ci","project":"my-aaa","registry":"dockerhub.kubekey.local","version":"v1"}`
	ref, lines := e.dockerBuildSteps(cfg, "payment-api-ci")

	if !strings.HasPrefix(lines[0], "$ ") {
		t.Fatalf("first line must be a '$ ' command line, got: %q", lines[0])
	}
	body := lines[0][2:] // 去掉 "$ " 前缀
	if !strings.Contains(body, "cat > .dockerfile.gen <<'DOCKERFILE_EOF'") {
		t.Errorf("missing heredoc opener in: %q", body)
	}
	if !strings.Contains(body, "FROM openjdk:17") || !strings.Contains(body, "ENTRYPOINT java -jar app.jar") {
		t.Errorf("Dockerfile content lost from heredoc body: %q", body)
	}
	if !strings.Contains(body, "DOCKERFILE_EOF") {
		t.Errorf("missing heredoc terminator: %q", body)
	}
	if !strings.Contains(body, "docker build -f .dockerfile.gen -t dockerhub.kubekey.local/my-aaa/payment-api-ci:v1 payment/") {
		t.Errorf("missing docker build command: %q", body)
	}
	// heredoc 正文（FROM/WORKDIR/...）与 docker build 必须出现在同一条 "$ " 行里，
	// 否则 realExec 只会执行 "$ cat ..." 这一行、把正文当日志丢弃。
	if strings.Count(body, "\n") < 4 {
		t.Errorf("expected heredoc+command on a single multi-line '$ ' line, got %q", body)
	}
	t.Logf("ref=%s\nfirstLine=\n%s", ref, body)
}
