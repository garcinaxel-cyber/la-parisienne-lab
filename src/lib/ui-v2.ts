// UI v2 ("Ivoire & cacao") — rollout switch by team (Axel, 12/11/2026).
// Every team gets the new colours. Only the teams listed here get the new STRUCTURE
// (bottom tab bar on phones, lighter header, Menu by families, redesigned screens).
// The other teams keep the screen they had on main. Widen team by team by adding its key.
export const UI_V2_TEAMS: readonly string[] = ['hung', 'baby_mama', 'entremet', 'baker'];

export function isUiV2Team(team: string | null | undefined): boolean {
  return !!team && UI_V2_TEAMS.includes(team);
}
