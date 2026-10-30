import ansis from 'ansis'

export function isTTY() {
  return process.stdout.isTTY === true
}

export function terminalHasColor() {
  return ansis.level > 0
}
