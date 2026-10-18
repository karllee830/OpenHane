// 头像：昵称首字 + 由 UID 决定的颜色；说话时外圈亮起。
const PALETTE = ['#e57373', '#f06292', '#ba68c8', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#ffb74d', '#a1887f', '#90a4ae'];

/** 这个人的头像颜色（舞台画面的底色也用它） */
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function initials(name: string): string {
  const ch = [...name.trim()][0] ?? '?';
  return ch.toUpperCase();
}

export function Avatar({ name, uid, speaking, size = 32, dimmed }: { name: string; uid: string; speaking?: boolean; size?: number; dimmed?: boolean }) {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white transition-shadow duration-100 ${dimmed ? 'opacity-50' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: avatarColor(uid),
        boxShadow: speaking ? `0 0 0 2px var(--color-bg), 0 0 0 ${Math.max(3, size / 14) + 2}px var(--color-speaking)` : undefined,
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}
