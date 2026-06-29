// Per-season conference + seed assignments — extracted ONCE from the season xlsx
// Standings tabs (one-and-done historical data; the live app derives this for new
// seasons). Tours 1, 2, and 4 used conferences; Tour 3 was Swiss (absent here).
// Each entry is [teamName, seed]; names may be truncated as they appear in the
// sheet ("…") and are fuzzy-matched to the imported team names.
export const SEASON_CONFERENCES = {
  1: {
    "Ancient Conference": [["Cloud Niners", 1], ["Supersonic Soaring Stuntmen", 2], ["Super Auto Cats", 3], ["Team Joemoe", 4], ["Meloncholic Misplayers", 5], ["bob is fishing in wisconsin", 6]],
    "Idol Conference": [["Thievin' Stevens", 1], ["Good Girls", 2], ["Flush Nine", 3], ["1-800-HOT-N-SPICY", 4], ["Balatro/Stay Night", 5], ["FreeGoonkeep", 6]],
    "Baron Conference": [["Follow Pi...ton Power", 1], ["Apes Together", 2], ["Team Marban", 3], ["Snailzaaks", 4], ["Team Nightmare", 5], ["The Holy Team", 6]],
  },
  2: {
    "Hack Conference": [["The Boss Blinds", 1], ["The Nine Dusketeers", 2], ["Flushes Before Crushes", 3], ["Foil Bull", 4], ["The Golden Flowchart", 5], ["Constellation Comrades", 6]],
    "Sock Conference": [["Crack Therapy", 1], ["Animal Farm", 2], ["Nobody Knows", 3], ["Friends! With benefits", 4], ["Flush Five Fajitas", 5], ["$100 Wraiths", 6]],
    "Dusk Conference": [["Friends are Stronger Together", 1], ["Foods and Dudes", 2], ["The Event Horizon", 3], ["Jumbo Buffoon Pack", 4], ["Oops All 1 Seeds!", 5], ["Good Girls", 6]],
  },
  4: {
    "Pluto Conference": [["Ante-Social Gamblers", 1], ["Unlimited Blockworks", 2], ["Calculated Gambling", 3], ["Ten Gallon Hat Wearers", 4], ["Team Reel", 5], ["Gold Stake Force Fem", 6], ["Bovine Battalion", 7], ["Photo Chuds", 8], ["Team Vagabond", 9], ["Team Hydra", 10]],
    "Eris Conference": [["Fruitful Bountchis", 1], ["Broke Barons", 2], ["Slam Dunks", 3], ["Owen-8", 4], ["Jimbo's Gymbros", 5], ["Inquisitive Immolation", 6], ["Team Name Pending", 7], ["High Card Society", 8], ["Reroll Models", 9], ["Goog...", 10]],
  },
};
