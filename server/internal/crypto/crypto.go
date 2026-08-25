// Package crypto 提供轻量级对称加密工具，用于敏感字段（如镜像仓库密码）落库加密。
//
// 设计：
//   - 使用 AES-256-GCM（AEAD，防篡改）。
//   - 密钥取自环境变量 DUNHELM_AES_KEY（32 字节）；缺省提供一个本地开发的静态密钥。
//     生产环境务必注入强随机密钥，否则加密形同虚设。
//   - 密文以 base64 存储，格式 = base64(nonce || ciphertext)。
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"os"

	"golang.org/x/crypto/bcrypt"
)

// key 为 AES-256 对称密钥（32 字节）。
var key []byte

func init() {
	raw := os.Getenv("DUNHELM_AES_KEY")
	if len(raw) == 0 {
		raw = "dunhelm-dev-aes256-static-key-0000000000"
	}
	key = make([]byte, 32)
	copy(key, []byte(raw))
}

// Encrypt 加密明文，返回 base64 密文（含随机 nonce）。空串直接返回空串。
func Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ct), nil
}

// Decrypt 解密 base64 密文，返回明文。解密失败（如旧明文或密钥不匹配）返回错误，
// 调用方应保留原值并忽略错误，避免破坏历史数据。
func Decrypt(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", nil
	}
	data, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(data) < ns {
		return "", errors.New("ciphertext too short")
	}
	nonce, ct := data[:ns], data[ns:]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// ---------- 密码哈希（bcrypt）----------

// HashPassword 用 bcrypt 对明文密码做单向哈希，返回可安全存储的哈希串。
// 空密码返回空串（调用方应拒绝空密码）。
func HashPassword(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// CheckPassword 校验明文密码与 bcrypt 哈希是否匹配。任一为空直接返回 false。
func CheckPassword(plain, hash string) bool {
	if hash == "" || plain == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}
