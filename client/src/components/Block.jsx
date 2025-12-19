import { useState, useRef, useEffect } from 'react';

const BLOCK_TYPES = [
  { type: 'paragraph', label: 'Text', icon: '¶' },
  { type: 'heading1', label: 'Heading 1', icon: 'H1' },
  { type: 'heading2', label: 'Heading 2', icon: 'H2' },
  { type: 'heading3', label: 'Heading 3', icon: 'H3' },
  { type: 'bullet-list', label: 'Bullet List', icon: '•' },
  { type: 'numbered-list', label: 'Numbered List', icon: '1.' },
  { type: 'quote', label: 'Quote', icon: '"' },
  { type: 'code', label: 'Code', icon: '</>' }
];

function Block({ block, index, onUpdate, onAddBlock, onDeleteBlock, onChangeType }) {
  const [showMenu, setShowMenu] = useState(false);
  const [menuFilter, setMenuFilter] = useState('');
  const contentRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (contentRef.current && contentRef.current.textContent !== block.content) {
      contentRef.current.textContent = block.content;
    }
  }, [block.content]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowMenu(false);
        setMenuFilter('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInput = (e) => {
    const content = e.target.textContent;

    // Check for slash command
    if (content === '/') {
      setShowMenu(true);
      setMenuFilter('');
      return;
    }

    if (showMenu && content.startsWith('/')) {
      setMenuFilter(content.slice(1).toLowerCase());
      return;
    }

    if (showMenu && !content.startsWith('/')) {
      setShowMenu(false);
      setMenuFilter('');
    }

    onUpdate(block.id, content, block.type);
  };

  const handleKeyDown = async (e) => {
    if (showMenu) {
      const filteredTypes = BLOCK_TYPES.filter((t) =>
        t.label.toLowerCase().includes(menuFilter)
      );

      if (e.key === 'Escape') {
        setShowMenu(false);
        setMenuFilter('');
        contentRef.current.textContent = '';
        return;
      }

      if (e.key === 'Enter' && filteredTypes.length > 0) {
        e.preventDefault();
        selectBlockType(filteredTypes[0].type);
        return;
      }

      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const newBlockId = await onAddBlock(block.id);

      // Focus the new block
      setTimeout(() => {
        const newBlockEl = document.querySelector(`[data-block-id="${newBlockId}"]`);
        if (newBlockEl) {
          newBlockEl.focus();
        }
      }, 50);
    }

    if (e.key === 'Backspace' && contentRef.current.textContent === '') {
      e.preventDefault();
      const prevBlockId = await onDeleteBlock(block.id);

      // Focus the previous block
      if (prevBlockId) {
        setTimeout(() => {
          const prevBlockEl = document.querySelector(`[data-block-id="${prevBlockId}"]`);
          if (prevBlockEl) {
            prevBlockEl.focus();
            // Move cursor to end
            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(prevBlockEl);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }, 50);
      }
    }
  };

  const selectBlockType = (type) => {
    setShowMenu(false);
    setMenuFilter('');
    contentRef.current.textContent = '';
    onChangeType(block.id, type);

    setTimeout(() => {
      contentRef.current.focus();
    }, 0);
  };

  const getPlaceholder = () => {
    switch (block.type) {
      case 'heading1':
        return 'Heading 1';
      case 'heading2':
        return 'Heading 2';
      case 'heading3':
        return 'Heading 3';
      case 'bullet-list':
        return 'List item';
      case 'numbered-list':
        return 'List item';
      case 'quote':
        return 'Quote';
      case 'code':
        return 'Code';
      default:
        return "Type '/' for commands...";
    }
  };

  const filteredTypes = BLOCK_TYPES.filter((t) =>
    t.label.toLowerCase().includes(menuFilter)
  );

  return (
    <div className="block">
      <span className="block-handle">⋮⋮</span>

      <div
        ref={contentRef}
        data-block-id={block.id}
        className={`block-content ${block.type}`}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={getPlaceholder()}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
      />

      {showMenu && (
        <div className="block-menu" ref={menuRef}>
          {filteredTypes.length > 0 ? (
            filteredTypes.map((t) => (
              <div
                key={t.type}
                className="block-menu-item"
                onClick={() => selectBlockType(t.type)}
              >
                <span className="block-menu-item-icon">{t.icon}</span>
                <span>{t.label}</span>
              </div>
            ))
          ) : (
            <div style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>
              No results
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Block;
