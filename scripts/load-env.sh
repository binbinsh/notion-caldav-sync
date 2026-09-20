#!/usr/bin/env bash

# Load simple KEY=VALUE files without executing their contents. Existing
# process environment variables win over values stored in the file.
load_env_file() {
  local env_path="$1" line key value first last
  [[ -f "$env_path" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      printf 'Invalid line in %s: expected KEY=VALUE\n' "$env_path" >&2
      return 1
    fi
    key=${line%%=*}
    value=${line#*=}
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      printf 'Invalid variable name in %s: %s\n' "$env_path" "$key" >&2
      return 1
    fi
    if [[ ${#value} -ge 2 ]]; then
      first=${value:0:1}
      last=${value:$((${#value} - 1)):1}
      if [[ ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ]]; then
        value=${value:1:$((${#value} - 2))}
      fi
    fi
    if ! declare -p "$key" >/dev/null 2>&1; then
      printf -v "$key" '%s' "$value"
      export "$key"
    fi
  done < "$env_path"
}
