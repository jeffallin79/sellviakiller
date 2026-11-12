import { Rail } from '@/components/Rail';

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="console">
      <Rail />
      <main className="main" id="main">
        <div className="main__inner">{children}</div>
      </main>
    </div>
  );
}
