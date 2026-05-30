const permissions: string[] = [];

registerPermission('sodium.api.keys.view');
registerPermission('sodium.api.keys.create');
registerPermission('sodium.api.keys.delete');
registerPermission('sodium.api.keys.edit');

registerPermission('sodium.api.servers.read');
registerPermission('sodium.api.servers.create');
registerPermission('sodium.api.servers.update');
registerPermission('sodium.api.servers.delete');
registerPermission('sodium.api.users.read');
registerPermission('sodium.api.users.create');
registerPermission('sodium.api.users.update');
registerPermission('sodium.api.users.delete');
registerPermission('sodium.api.nodes.read');
registerPermission('sodium.api.nodes.create');
registerPermission('sodium.api.nodes.update');
registerPermission('sodium.api.nodes.delete');
registerPermission('sodium.api.settings.read');
registerPermission('sodium.api.settings.update');

export function registerPermission(permission: string): void {
  if (!permissions.includes(permission)) {
    permissions.push(permission);
  }
}

export default permissions;
