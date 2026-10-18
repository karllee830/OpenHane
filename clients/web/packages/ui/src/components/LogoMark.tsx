import logoDark from '../assets/logo-dark.png';
import logoLight from '../assets/logo-light.png';

/** 品牌标识：应用图标（clients/apple/Shared/OpenHane.icon）的渲染图，浅色 / 深色跟随系统（与苹果客户端一致）。 */
export function LogoMark({ size = 56 }: { size?: number }) {
  return (
    <picture className="shrink-0">
      <source srcSet={logoDark} media="(prefers-color-scheme: dark)" />
      <img src={logoLight} width={size} height={size} alt="" aria-hidden draggable={false} className="drop-shadow-md select-none" />
    </picture>
  );
}
