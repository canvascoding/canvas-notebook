import { NotebookLoadingSkeleton } from '@/app/components/notebook/NotebookLoadingSkeleton';

export default function NotebookLoading() {
  return <div className="flex h-dvh min-h-0 w-full"><NotebookLoadingSkeleton /></div>;
}
