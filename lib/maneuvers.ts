// GraphHopper instruction "sign" -> a simple arrow glyph for the turn banner.
// https://docs.graphhopper.com/#operation/postRoute (Instruction.sign)
export function signArrow(sign: number): string {
  switch (sign) {
    case -98: // unknown u-turn
    case -8: // left u-turn
    case 8: // right u-turn
      return "⤺";
    case -7: // keep left
      return "↖";
    case -3: // sharp left
    case -2: // left
      return "↰";
    case -1: // slight left
      return "↖";
    case 0: // continue
      return "↑";
    case 1: // slight right
      return "↗";
    case 2: // right
    case 3: // sharp right
      return "↱";
    case 7: // keep right
      return "↗";
    case 6: // roundabout
      return "↻";
    case 4: // finish
    case 5: // via reached
      return "◉";
    default:
      return "↑";
  }
}
