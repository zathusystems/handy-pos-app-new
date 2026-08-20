'use client';

import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';

export function useSessionPagination<T>(items: T[], itemsPerPage = 10) {
  const [currentPage, setCurrentPage] = React.useState(1);

  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
  const effectiveCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = totalItems === 0 ? 0 : (effectiveCurrentPage - 1) * itemsPerPage + 1;
  const pageEndIndex = Math.min(effectiveCurrentPage * itemsPerPage, totalItems);

  const paginatedItems = React.useMemo(
    () => items.slice((effectiveCurrentPage - 1) * itemsPerPage, effectiveCurrentPage * itemsPerPage),
    [effectiveCurrentPage, items, itemsPerPage]
  );

  React.useEffect(() => {
    setCurrentPage((prevPage) => Math.min(prevPage, totalPages));
  }, [totalPages]);

  return {
    currentPage: effectiveCurrentPage,
    setCurrentPage,
    totalItems,
    totalPages,
    pageStartIndex,
    pageEndIndex,
    paginatedItems,
  };
}

interface SessionPaginationControlsProps {
  currentPage: number;
  totalItems: number;
  totalPages: number;
  pageStartIndex: number;
  pageEndIndex: number;
  onPageChange: (page: number) => void;
  itemLabel: string;
}

export function SessionPaginationControls({
  currentPage,
  totalItems,
  totalPages,
  pageStartIndex,
  pageEndIndex,
  onPageChange,
  itemLabel,
}: SessionPaginationControlsProps) {
  if (totalItems === 0 || totalPages <= 1) {
    return null;
  }

  const maxVisiblePages = 5;
  const pageWindowStart = Math.max(
    1,
    Math.min(currentPage - Math.floor(maxVisiblePages / 2), totalPages - maxVisiblePages + 1)
  );
  const pageWindowEnd = Math.min(totalPages, pageWindowStart + maxVisiblePages - 1);
  const visiblePages = Array.from(
    { length: pageWindowEnd - pageWindowStart + 1 },
    (_, index) => pageWindowStart + index
  );

  return (
    <div className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Showing {pageStartIndex}-{pageEndIndex} of {totalItems} {itemLabel}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(Math.max(currentPage - 1, 1))}
          disabled={currentPage === 1}
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          Prev
        </Button>
        {visiblePages.map((pageNumber) => (
          <Button
            key={pageNumber}
            variant={pageNumber === currentPage ? 'default' : 'outline'}
            size="sm"
            onClick={() => onPageChange(pageNumber)}
            className="min-w-10"
          >
            {pageNumber}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(Math.min(currentPage + 1, totalPages))}
          disabled={currentPage === totalPages}
        >
          Next
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
