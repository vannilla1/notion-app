import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import NotificationToast from '../NotificationToast';

// Mock useSocket hook
const mockSocket = {
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock('../../hooks/useSocket', () => ({
  useSocket: () => ({
    socket: mockSocket,
    isConnected: true,
  }),
}));

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('NotificationToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSocket.on.mockClear();
    mockSocket.off.mockClear();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderComponent = () => {
    return render(
      <BrowserRouter>
        <NotificationToast />
      </BrowserRouter>
    );
  };

  const simulateNotification = (notification) => {
    // Find the notification handler and call it
    const onCall = mockSocket.on.mock.calls.find(
      call => call[0] === 'notification'
    );
    if (onCall && onCall[1]) {
      act(() => {
        onCall[1](notification);
      });
    }
  };

  describe('rendering', () => {
    it('should render nothing when no toasts', () => {
      const { container } = renderComponent();
      expect(container.querySelector('.toast-container')).toBeNull();
    });

    it('should display toast when notification received', async () => {
      renderComponent();

      simulateNotification({
        id: 'test-1',
        type: 'task.created',
        title: 'Nová úloha vytvorená',
      });

      expect(screen.getByText('Nová úloha vytvorená')).toBeInTheDocument();
    });

    it('should display message if provided', () => {
      renderComponent();

      simulateNotification({
        id: 'test-2',
        type: 'contact.updated',
        title: 'Kontakt aktualizovaný',
        message: 'Zmena telefónneho čísla',
      });

      expect(screen.getByText('Kontakt aktualizovaný')).toBeInTheDocument();
      expect(screen.getByText('Zmena telefónneho čísla')).toBeInTheDocument();
    });
  });

  describe('icons', () => {
    it('should show contact icon for contact notifications', () => {
      renderComponent();

      simulateNotification({
        id: 'icon-1',
        type: 'contact.created',
        title: 'Test',
      });

      expect(screen.getByText('👤')).toBeInTheDocument();
    });

    it('should show task icon for task notifications', () => {
      renderComponent();

      simulateNotification({
        id: 'icon-2',
        type: 'task.completed',
        title: 'Test',
      });

      expect(screen.getByText('✅')).toBeInTheDocument();
    });

    it('should show subtask icon for subtask notifications', () => {
      renderComponent();

      simulateNotification({
        id: 'icon-3',
        type: 'subtask.created',
        title: 'Test',
      });

      expect(screen.getByText('📝')).toBeInTheDocument();
    });

    it('should show default icon for unknown types', () => {
      renderComponent();

      simulateNotification({
        id: 'icon-4',
        type: 'unknown.type',
        title: 'Test',
      });

      expect(screen.getByText('🔔')).toBeInTheDocument();
    });
  });

  describe('color classes', () => {
    it('should apply success class for created notifications', () => {
      renderComponent();

      simulateNotification({
        id: 'color-1',
        type: 'task.created',
        title: 'Test',
      });

      const toast = screen.getByText('Test').closest('.toast');
      expect(toast).toHaveClass('toast-success');
    });

    it('should apply danger class for deleted notifications', () => {
      renderComponent();

      simulateNotification({
        id: 'color-2',
        type: 'contact.deleted',
        title: 'Test',
      });

      const toast = screen.getByText('Test').closest('.toast');
      expect(toast).toHaveClass('toast-danger');
    });

    it('should apply info class for assigned notifications', () => {
      renderComponent();

      simulateNotification({
        id: 'color-3',
        type: 'task.assigned',
        title: 'Test',
      });

      const toast = screen.getByText('Test').closest('.toast');
      expect(toast).toHaveClass('toast-info');
    });

    it('should apply success class for completed notifications', () => {
      renderComponent();

      simulateNotification({
        id: 'color-4',
        type: 'task.completed',
        title: 'Test',
      });

      const toast = screen.getByText('Test').closest('.toast');
      expect(toast).toHaveClass('toast-success');
    });
  });

  describe('auto-dismiss', () => {
    it('should remove toast after 5 seconds', async () => {
      renderComponent();

      simulateNotification({
        id: 'auto-1',
        type: 'task.created',
        title: 'Auto dismiss test',
      });

      expect(screen.getByText('Auto dismiss test')).toBeInTheDocument();

      // Fast-forward 5 seconds and flush all timers
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await vi.runAllTimersAsync();
      });

      expect(screen.queryByText('Auto dismiss test')).not.toBeInTheDocument();
    });
  });

  describe('manual dismiss', () => {
    it('should remove toast when close button clicked', () => {
      renderComponent();

      simulateNotification({
        id: 'manual-1',
        type: 'task.created',
        title: 'Manual dismiss test',
      });

      const closeButton = screen.getByText('×');
      fireEvent.click(closeButton);

      expect(screen.queryByText('Manual dismiss test')).not.toBeInTheDocument();
    });
  });

  describe('duplicate prevention', () => {
    it('should not add duplicate notifications with same id', () => {
      renderComponent();

      simulateNotification({
        id: 'dup-1',
        type: 'task.created',
        title: 'First',
      });

      simulateNotification({
        id: 'dup-1',
        type: 'task.created',
        title: 'Duplicate',
      });

      expect(screen.getAllByText('First')).toHaveLength(1);
      expect(screen.queryByText('Duplicate')).not.toBeInTheDocument();
    });
  });

  describe('max toast limit', () => {
    it('should limit to 5 toasts', () => {
      renderComponent();

      // Add 7 notifications
      for (let i = 1; i <= 7; i++) {
        simulateNotification({
          id: `limit-${i}`,
          type: 'task.created',
          title: `Toast ${i}`,
        });
      }

      const toasts = screen.getAllByRole('button'); // Close buttons
      expect(toasts).toHaveLength(5);

      // Should show the last 5 (3-7)
      expect(screen.queryByText('Toast 1')).not.toBeInTheDocument();
      expect(screen.queryByText('Toast 2')).not.toBeInTheDocument();
      expect(screen.getByText('Toast 3')).toBeInTheDocument();
      expect(screen.getByText('Toast 7')).toBeInTheDocument();
    });
  });

  describe('navigation', () => {
    it('should navigate to CRM when clicking contact notification', () => {
      renderComponent();

      simulateNotification({
        id: 'nav-1',
        type: 'contact.created',
        title: 'New contact',
        relatedType: 'contact',
        data: { contactId: 'contact-123' },
      });

      const toast = screen.getByText('New contact').closest('.toast');
      fireEvent.click(toast);

      expect(mockNavigate).toHaveBeenCalledWith('/crm', {
        state: { expandContactId: 'contact-123' },
      });
    });

    it('should navigate to tasks when clicking task notification', () => {
      renderComponent();

      simulateNotification({
        id: 'nav-2',
        type: 'task.completed',
        title: 'Task done',
        relatedType: 'task',
        data: { taskId: 'task-456' },
      });

      const toast = screen.getByText('Task done').closest('.toast');
      fireEvent.click(toast);

      expect(mockNavigate).toHaveBeenCalledWith('/tasks', {
        state: { highlightTaskId: 'task-456' },
      });
    });

    it('should navigate to tasks when clicking subtask notification', () => {
      renderComponent();

      simulateNotification({
        id: 'nav-3',
        type: 'subtask.created',
        title: 'Subtask added',
        relatedType: 'subtask',
        data: { taskId: 'parent-task-789' },
      });

      const toast = screen.getByText('Subtask added').closest('.toast');
      fireEvent.click(toast);

      expect(mockNavigate).toHaveBeenCalledWith('/tasks', {
        state: { highlightTaskId: 'parent-task-789' },
      });
    });

    it('should remove toast after clicking', () => {
      renderComponent();

      simulateNotification({
        id: 'nav-4',
        type: 'task.created',
        title: 'Click to remove',
        relatedType: 'task',
        data: { taskId: 'task-1' },
      });

      const toast = screen.getByText('Click to remove').closest('.toast');
      fireEvent.click(toast);

      expect(screen.queryByText('Click to remove')).not.toBeInTheDocument();
    });
  });

  describe('socket lifecycle', () => {
    it('should register notification listener on mount', () => {
      renderComponent();

      expect(mockSocket.on).toHaveBeenCalledWith(
        'notification',
        expect.any(Function)
      );
    });

    it('should unregister notification listener on unmount', () => {
      const { unmount } = renderComponent();
      unmount();

      expect(mockSocket.off).toHaveBeenCalledWith(
        'notification',
        expect.any(Function)
      );
    });
  });
});
