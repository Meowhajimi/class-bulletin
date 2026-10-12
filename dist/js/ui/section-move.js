/**
 * 「把这个栏目里的公告搬到另一个栏目」—— 删栏目之前的那一步。
 *
 * 为什么单独一个模块：
 *   删栏目要求栏目里没有公告（数据库层有外键限制，后端也会返回 409）。
 *   但光"拒绝删除"是个死胡同：学习委员想删掉一个临时栏目时，
 *   得自己在列表里一条条改栏目，很容易找不到入口。
 *   所以这里提供"搬完再删"的能力，让删栏目真的能完成。
 *
 * 逻辑是纯的（只依赖数据源接口），所以可以在 node 里用假数据源测试。
 */

/**
 * 把 fromId 栏目下的公告逐条改到 toId 栏目。
 *
 * 设计取舍：
 *   · **逐条**更新，不用批量接口 —— 后端契约里只有 updateMessage，
 *     而为了这个功能新增一个批量接口不划算（公告数量本来就不大）。
 *   · **不抛异常**，而是返回失败清单：搬到一半失败时，
 *     界面要能告诉用户"搬成功了 3 条、失败 2 条"，而不是整件事看起来没发生。
 *   · **只搬指定的那些**（调用方传进来），不自己去查全表 —— 数据来源保持一致。
 *
 * @param {{updateMessage: (id: string, patch: object) => Promise<any>}} source
 * @param {Array<{id: string, section_id?: string}>} messages 全部公告
 * @param {string} fromId 源栏目
 * @param {string} toId   目标栏目
 * @returns {Promise<{moved: string[], failed: Array<{id: string, error: unknown}>}>}
 */
export async function moveSectionMessages(source, messages, fromId, toId) {
  const moved = [];
  const failed = [];

  if (!source || typeof source.updateMessage !== 'function') {
    return { moved, failed };
  }
  if (!fromId || !toId || fromId === toId) {
    return { moved, failed };
  }

  const targets = (messages || []).filter(
    (message) => message && String(message.section_id || '') === String(fromId),
  );

  for (const message of targets) {
    try {
      await source.updateMessage(message.id, { section_id: toId });
      moved.push(message.id);
    } catch (error) {
      failed.push({ id: message.id, error });
    }
  }

  return { moved, failed };
}

/**
 * 某个栏目里还剩几条公告 —— 用来决定"能不能直接删"。
 * @param {Array<{section_id?: string}>} messages
 * @param {string} sectionId
 * @returns {number}
 */
export function countInSection(messages, sectionId) {
  return (messages || []).filter(
    (message) => message && String(message.section_id || '') === String(sectionId),
  ).length;
}
