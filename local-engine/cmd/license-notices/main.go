// Collect notices from the exact go.mod graph; no dependency version selection.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) != 2 {
		panic("output directory required")
	}
	root := os.Args[1]
	if err := os.MkdirAll(root, 0755); err != nil {
		panic(err)
	}
	command := exec.Command("go", "list", "-deps", "-json", "./cmd/local-engine")
	raw, err := command.Output()
	if err != nil {
		panic(err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	var index strings.Builder
	seen := map[string]bool{}
	for {
		var pkg struct {
			Module *struct {
				Path, Version, Dir string
				Main               bool
			}
		}
		if err := decoder.Decode(&pkg); err != nil {
			if err == io.EOF {
				break
			}
			panic(err)
		}
		module := pkg.Module
		if module == nil || module.Main || seen[module.Path] {
			continue
		}
		seen[module.Path] = true
		fmt.Fprintf(&index, "%s %s\n", module.Path, module.Version)
		if module.Dir == "" {
			panic("module not downloaded: " + module.Path)
		}
		files, err := os.ReadDir(module.Dir)
		if err != nil {
			panic(err)
		}
		for _, entry := range files {
			name := strings.ToLower(entry.Name())
			if entry.IsDir() || !(strings.HasPrefix(name, "license") || strings.HasPrefix(name, "copying") || strings.HasPrefix(name, "notice")) {
				continue
			}
			data, err := os.ReadFile(filepath.Join(module.Dir, entry.Name()))
			if err != nil {
				panic(err)
			}
			directory := filepath.Join(root, strings.ReplaceAll(module.Path, "/", "_")+"@"+module.Version)
			if err := os.MkdirAll(directory, 0755); err != nil {
				panic(err)
			}
			if err := os.WriteFile(filepath.Join(directory, entry.Name()), data, 0644); err != nil {
				panic(err)
			}
		}
	}
	if err := os.WriteFile(filepath.Join(root, "GO-MODULES.txt"), []byte(index.String()), 0644); err != nil {
		panic(err)
	}
}
