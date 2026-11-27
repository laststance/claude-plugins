# Source once in an interactive zsh to let /move-project replace the foreground CLI.
typeset -g _claude_move_project_launcher="${${(%):-%x}:A:h:h}/scripts/launcher.py"

function claude() {
  emulate -L zsh
  # An upgraded or removed plugin must not break Claude in an already-open shell.
  if [[ ! -r "$_claude_move_project_launcher" || ! -t 0 || ! -t 1 ]]; then
    command claude "$@"
    return $?
  fi
  case "${1:-}" in
    agents|attach|auth|auto-mode|daemon|doctor|gateway|import|install|logs|mcp|plugin|plugins|purge|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade)
      command claude "$@"; return $? ;;
  esac
  local argument
  for argument in "$@"; do
    case "$argument" in
      --) break ;;
      -p|--print|-h|--help|-v|--version|--bg|--background|--cloud|--desktop)
        command claude "$@"; return $? ;;
    esac
  done
  command python3 -I "$_claude_move_project_launcher" run -- "$@"
}
