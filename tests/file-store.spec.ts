import { useFileStore } from '../app/store/file-store';
import { act, renderHook } from '@testing-library/react';

describe('File Store', () => {
  it('should toggle multi-select mode', () => {
    const { result } = renderHook(() => useFileStore());

    expect(result.current.isMultiSelectMode).toBe(false);

    act(() => {
      result.current.toggleMultiSelectMode();
    });

    expect(result.current.isMultiSelectMode).toBe(true);

    act(() => {
      result.current.toggleMultiSelectMode();
    });

    expect(result.current.isMultiSelectMode).toBe(false);
  });

  it('should add and remove paths from multi-select', () => {
    const { result } = renderHook(() => useFileStore());

    expect(result.current.multiSelectPaths).toEqual([]);

    act(() => {
      result.current.toggleMultiSelectPath('/path/to/file1');
    });
    expect(result.current.multiSelectPaths).toEqual(['/path/to/file1']);

    act(() => {
      result.current.toggleMultiSelectPath('/path/to/file2');
    });
    expect(result.current.multiSelectPaths).toEqual(['/path/to/file1', '/path/to/file2']);

    act(() => {
      result.current.toggleMultiSelectPath('/path/to/file1');
    });
    expect(result.current.multiSelectPaths).toEqual(['/path/to/file2']);

    act(() => {
      result.current.toggleMultiSelectPath('/path/to/file3');
    });
    expect(result.current.multiSelectPaths).toEqual(['/path/to/file2', '/path/to/file3']);
  });

  it('should clear multi-select paths when switching from multi-select to single select', () => {
    const { result } = renderHook(() => useFileStore());
  
    // Activate multi-select mode and add some paths
    act(() => {
      result.current.toggleMultiSelectMode();
      result.current.toggleMultiSelectPath('/path/to/file1');
      result.current.toggleMultiSelectPath('/path/to/file2');
    });
    expect(result.current.isMultiSelectMode).toBe(true);
    expect(result.current.multiSelectPaths).toEqual(['/path/to/file1', '/path/to/file2']);
  
    // Simulate a single selection (ctrlOrMeta = false)
    act(() => {
      result.current.selectNode({ name: 'file3', path: '/path/to/file3', type: 'file' }, false);
    });
  
    // Expect multi-select mode to be off and paths cleared
    expect(result.current.isMultiSelectMode).toBe(false);
    expect(result.current.multiSelectPaths).toEqual([]);
    expect(result.current.selectedNode?.path).toBe('/path/to/file3');
  });

  it('should activate multi-select mode and clear previous selection if ctrlOrMeta is pressed and not in multi-select mode', () => {
    const { result } = renderHook(() => useFileStore());
  
    // Simulate initial single selection
    act(() => {
      result.current.selectNode({ name: 'fileA', path: '/path/to/fileA', type: 'file' });
    });
    expect(result.current.selectedNode?.path).toBe('/path/to/fileA');
    expect(result.current.isMultiSelectMode).toBe(false);
    expect(result.current.multiSelectPaths).toEqual([]);
  
    // Press Ctrl/Meta, expect multi-select mode to activate and previous single selection to clear
    act(() => {
      result.current.selectNode({ name: 'fileB', path: '/path/to/fileB', type: 'file' }, true);
    });
  
    expect(result.current.isMultiSelectMode).toBe(true);
    expect(result.current.selectedNode).toBeNull(); // Previous single selection cleared
    expect(result.current.multiSelectPaths).toEqual(['/path/to/fileB']);
  });

});
