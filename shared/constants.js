// Core constants shared between server (Node) and client (browser).

export const EMPTY = 0;
export const WALL = 1; // indestructible pillar / border
export const BOX = 2; // destructible crate

export const BOMB_TIMER = 2.2; // seconds before a bomb explodes
export const EXPLOSION_TIME = 0.5; // seconds a flame tile stays active
export const POWERUP_CHANCE = 0.34; // chance a destroyed box drops a power-up

export const P_HALF = 0.35; // player half-size in tile units (hitbox)

export const START_BOMBS = 1;
export const START_RANGE = 2;
export const START_SPEED = 4.6; // tiles per second
export const MAX_RANGE = 9;
export const MAX_BOMBS = 8;
export const MAX_SPEED = 8.5;

export const POWERUPS = ['bomb', 'range', 'speed'];

// Map size presets (odd numbers work best for the pillar grid).
export const MAP_SIZES = {
  small: { w: 15, h: 13, label: 'Nhỏ' },
  medium: { w: 21, h: 15, label: 'Vừa' },
  big: { w: 27, h: 19, label: 'Bự' },
  huge: { w: 33, h: 23, label: 'Siêu bự' },
};

// Playable characters. Rendered as emoji avatars with a themed color ring.
export const CHARACTERS = [
  { id: 'fox', name: 'Cáo Cam', emoji: '🦊', color: '#ff7a45' },
  { id: 'frog', name: 'Ếch Xanh', emoji: '🐸', color: '#3ddc84' },
  { id: 'cat', name: 'Mèo Hồng', emoji: '🐱', color: '#ff6ec7' },
  { id: 'panda', name: 'Gấu Trúc', emoji: '🐼', color: '#8b9dc7' },
  { id: 'robot', name: 'Rôbốt', emoji: '🤖', color: '#00e5ff' },
  { id: 'penguin', name: 'Cánh Cụt', emoji: '🐧', color: '#5b8cff' },
  { id: 'unicorn', name: 'Kỳ Lân', emoji: '🦄', color: '#c77dff' },
  { id: 'tiger', name: 'Hổ Vằn', emoji: '🐯', color: '#ffd23f' },
  { id: 'alien', name: 'Người Ngoài', emoji: '👾', color: '#a0ff1f' },
  { id: 'ghost', name: 'Ma Lanh', emoji: '👻', color: '#e0e0ff' },
  { id: 'dragon', name: 'Rồng Lửa', emoji: '🐲', color: '#ff4d6d' },
  { id: 'octopus', name: 'Bạch Tuộc', emoji: '🐙', color: '#ff9e00' },
];

export function getCharacter(id) {
  return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
}
