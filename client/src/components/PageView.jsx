import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { useSocket } from '../hooks/useSocket';
import Block from './Block';

const ICONS = ['📄', '📝', '📋', '📌', '📎', '🔖', '📚', '📖', '✨', '💡', '🎯', '🚀', '⭐', '💻', '🔧', '📊'];

function PageView({ pageId, onUpdate }) {
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const titleRef = useRef(null);
  const { joinPage, leavePage, emitPageUpdate, emitBlockUpdate, onPageUpdated, onBlockUpdated } = useSocket();

  useEffect(() => {
    fetchPage();
    joinPage(pageId);

    return () => {
      leavePage(pageId);
    };
  }, [pageId]);

  useEffect(() => {
    const unsubPage = onPageUpdated((data) => {
      if (data.pageId === pageId) {
        setPage((prev) => ({
          ...prev,
          title: data.title !== undefined ? data.title : prev.title
        }));
      }
    });

    const unsubBlock = onBlockUpdated((data) => {
      if (data.pageId === pageId) {
        setPage((prev) => ({
          ...prev,
          blocks: prev.blocks.map((b) =>
            b.id === data.blockId
              ? { ...b, content: data.content, type: data.type }
              : b
          )
        }));
      }
    });

    return () => {
      if (unsubPage) unsubPage();
      if (unsubBlock) unsubBlock();
    };
  }, [pageId, onPageUpdated, onBlockUpdated]);

  const fetchPage = async () => {
    try {
      setLoading(true);
      const res = await axios.get(`/api/pages/${pageId}`);
      setPage(res.data);
    } catch (error) {
      console.error('Failed to fetch page:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateTitle = useCallback(
    async (newTitle) => {
      if (!page) return;

      setPage({ ...page, title: newTitle });
      emitPageUpdate(pageId, null, newTitle);

      try {
        const res = await axios.put(`/api/pages/${pageId}`, { title: newTitle });
        onUpdate(res.data);
      } catch (error) {
        console.error('Failed to update title:', error);
      }
    },
    [page, pageId, emitPageUpdate, onUpdate]
  );

  const updateIcon = async (newIcon) => {
    if (!page) return;

    setPage({ ...page, icon: newIcon });
    setShowIconPicker(false);

    try {
      const res = await axios.put(`/api/pages/${pageId}`, { icon: newIcon });
      onUpdate(res.data);
    } catch (error) {
      console.error('Failed to update icon:', error);
    }
  };

  const updateBlock = useCallback(
    async (blockId, content, type) => {
      if (!page) return;

      setPage({
        ...page,
        blocks: page.blocks.map((b) =>
          b.id === blockId ? { ...b, content, type } : b
        )
      });

      emitBlockUpdate(pageId, blockId, content, type);

      try {
        await axios.put(`/api/pages/${pageId}/blocks/${blockId}`, {
          content,
          type
        });
      } catch (error) {
        console.error('Failed to update block:', error);
      }
    },
    [page, pageId, emitBlockUpdate]
  );

  const addBlock = useCallback(
    async (afterBlockId, type = 'paragraph') => {
      if (!page) return;

      try {
        const res = await axios.post(`/api/pages/${pageId}/blocks`, {
          type,
          content: '',
          afterBlockId
        });

        const newBlock = res.data;
        const blocks = [...page.blocks];
        const index = blocks.findIndex((b) => b.id === afterBlockId);

        if (index !== -1) {
          blocks.splice(index + 1, 0, newBlock);
        } else {
          blocks.push(newBlock);
        }

        setPage({ ...page, blocks });
        return newBlock.id;
      } catch (error) {
        console.error('Failed to add block:', error);
      }
    },
    [page, pageId]
  );

  const deleteBlock = useCallback(
    async (blockId) => {
      if (!page || page.blocks.length <= 1) return;

      const blockIndex = page.blocks.findIndex((b) => b.id === blockId);
      const prevBlockId = blockIndex > 0 ? page.blocks[blockIndex - 1].id : null;

      try {
        await axios.delete(`/api/pages/${pageId}/blocks/${blockId}`);
        setPage({
          ...page,
          blocks: page.blocks.filter((b) => b.id !== blockId)
        });
        return prevBlockId;
      } catch (error) {
        console.error('Failed to delete block:', error);
      }
    },
    [page, pageId]
  );

  const changeBlockType = useCallback(
    (blockId, newType) => {
      if (!page) return;

      const block = page.blocks.find((b) => b.id === blockId);
      if (block) {
        updateBlock(blockId, block.content, newType);
      }
    },
    [page, updateBlock]
  );

  if (loading) {
    return (
      <div style={{ padding: '32px 96px', color: 'var(--text-muted)' }}>
        Loading...
      </div>
    );
  }

  if (!page) {
    return (
      <div style={{ padding: '32px 96px', color: 'var(--text-muted)' }}>
        Page not found
      </div>
    );
  }

  return (
    <div className="page-view">
      <div className="page-content">
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <div
            className="icon-picker"
            onClick={() => setShowIconPicker(!showIconPicker)}
          >
            {page.icon || '📄'}
          </div>
          {showIconPicker && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                background: 'white',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                padding: '8px',
                display: 'grid',
                gridTemplateColumns: 'repeat(8, 1fr)',
                gap: '4px',
                zIndex: 100,
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
              }}
            >
              {ICONS.map((icon) => (
                <button
                  key={icon}
                  onClick={() => updateIcon(icon)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    fontSize: '20px',
                    padding: '4px',
                    cursor: 'pointer',
                    borderRadius: '4px'
                  }}
                  onMouseOver={(e) => (e.target.style.backgroundColor = 'var(--bg-hover)')}
                  onMouseOut={(e) => (e.target.style.backgroundColor = 'transparent')}
                >
                  {icon}
                </button>
              ))}
            </div>
          )}
        </div>

        <input
          ref={titleRef}
          type="text"
          className="page-title-input"
          value={page.title || ''}
          onChange={(e) => updateTitle(e.target.value)}
          placeholder="Untitled"
        />

        <div className="blocks-container" style={{ marginTop: '24px' }}>
          {page.blocks.map((block, index) => (
            <Block
              key={block.id}
              block={block}
              index={index}
              onUpdate={updateBlock}
              onAddBlock={addBlock}
              onDeleteBlock={deleteBlock}
              onChangeType={changeBlockType}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default PageView;
