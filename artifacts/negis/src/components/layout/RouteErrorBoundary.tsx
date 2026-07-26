import { Component, type ErrorInfo, type ReactNode } from 'react';

/* Routes are code-split (React.lazy in App.tsx), so a route can now fail for a
   reason that did not exist when everything shipped in one bundle: the dynamic
   chunk request itself can fail — stale hashed filenames after a redeploy, a
   dropped connection, a CDN hiccup. Without a boundary that rejection escapes
   Suspense, React unmounts the tree, and the user gets a blank page.
   Reloading genuinely fixes the redeploy case: it fetches a fresh index.html
   with the current chunk hashes. */

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the detail in the console for support; the UI stays plain.
    console.error('Route failed to render', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center p-6"
        style={{ background: 'var(--ng-bg)' }}
      >
        <div className="neu-card max-w-[420px] text-center">
          <h1 className="text-base font-semibold" style={{ color: 'var(--ng-text)' }}>
            Не удалось загрузить раздел
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--ng-muted)' }}>
            Проверьте подключение и обновите страницу. Если приложение недавно обновилось,
            обновление загрузит новую версию.
          </p>
          <button
            type="button"
            className="neu-btn-primary mt-5"
            onClick={() => window.location.reload()}
          >
            Обновить страницу
          </button>
        </div>
      </div>
    );
  }
}
