//go:build !linux

package privdrop

// Drop 只在 Linux（Docker 镜像）上生效；其他平台什么都不做。
func Drop(dataDir string, getenv func(string) string) error { return nil }
