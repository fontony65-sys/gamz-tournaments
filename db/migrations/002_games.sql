-- Reference data (not example data): the games gamz hosts.
INSERT OR IGNORE INTO games (id,name,short_name,family,accent,formats,modes,sort_order) VALUES
 ('efootball','eFootball','eFootball','football','#818cf8','["single_elim","league","league_knockout"]','["1v1"]',1),
 ('dls','Dream League Soccer','DLS','football','#7dd3fc','["single_elim","league","league_knockout"]','["1v1"]',2),
 ('pubgm','PUBG Mobile','PUBG M','battle_royale','#c4b5fd','["br_points"]','["squad","duo","solo"]',3),
 ('codm','Call of Duty: Mobile','CoDM','team_shooter','#a5b4fc','["double_elim","single_elim","br_points"]','["5v5","squad","duo","solo"]',4);
