import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Raw HTML is not rendered (react-markdown default), so note content can't inject markup.
export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div
      className={`break-words space-y-2 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline [&_a]:text-[var(--ods-accent,#2563eb)] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_code]:rounded [&_code]:bg-black/5 [&_code]:px-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" />,
          // Website screenshots are full-page, so show them in a scroll box and open full size on click.
          img: ({ node: _n, src, alt }) => (
            <a href={src} target="_blank" rel="noopener noreferrer" title="Open full size"
              className="block max-h-[480px] overflow-y-auto rounded border border-black/10">
              <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" className="block w-full h-auto" />
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
