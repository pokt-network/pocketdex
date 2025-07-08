def inject_env_vars(resources, target_kind, target_name, container_name, env_vars):
    modified = []
    for r in resources:
        if r.get('kind') == target_kind and r['metadata']['name'] == target_name:
            containers = r['spec']['template']['spec']['containers']
            for container in containers:
                if container['name'] == container_name:
                    existing_env = container.setdefault('env', [])
                    for key, value in env_vars.items():
                        found = False
                        for env in existing_env:
                            if env['name'] == key:
                                env['value'] = value
                                found = True
                                break
                        if not found:
                            existing_env.append({'name': key, 'value': value})
        modified.append(r)

    return modified


def inject_args(resources, target_kind, target_name, container_name, new_args):
    modified = []
    for r in resources:
        if r.get('kind') == target_kind and r['metadata']['name'] == target_name:
            containers = r['spec']['template']['spec']['containers']
            for container in containers:
                if container['name'] == container_name:
                    args = container.setdefault('args', [])
                    args_map = {}
                    for arg in args:
                        if '=' in arg:
                            parts = arg.split('=', 1)
                            if len(parts) == 2:
                                args_map[parts[0]] = parts[1]
                        else:
                            args_map[arg] = None

                    for k, v in new_args.items():
                        args_map[k] = v

                    rebuilt_args = []
                    for k, v in args_map.items():
                        if v != None:
                            rebuilt_args.append("%s=%s" % (k, v))
                        else:
                            rebuilt_args.append(k)

                    container['args'] = rebuilt_args
        modified.append(r)
    return modified


def build_indexer_params_overwrite():
    result = {}

    # Flat env → key mapping
    flat_keys = {
        'NODE_OPTIONS': 'node_options',
        'CHAIN_ID': 'chain_id',
        'ENDPOINT': 'endpoint',
        'BATCH_SIZE': 'block_batch_size',
        'START_BLOCK': 'start_block',
        'POCKETDEX_DB_BATCH_SIZE': 'db_batch_size',
        'POCKETDEX_DB_PAGE_LIMIT': 'page_limit',
        'POCKETDEX_DB_BULK_WRITE_CONCURRENCY': 'db_bulk_concurrency',
    }

    for env_key, dict_key in flat_keys.items():
        value = os.getenv(env_key, '')
        if value != '':
            result[dict_key] = value

    # Nested pg_pool structure
    pg_pool_keys = ['min', 'max', 'acquire', 'idle', 'evict']
    pg_pool = {}

    for key in pg_pool_keys:
        env_key = 'PG_POOL_%s' % key.upper()
        value = os.getenv(env_key, '')
        if value != '':
            pg_pool[key] = value

    if pg_pool:
        result['pg_pool'] = pg_pool

    return result


def extract_env_and_args(params_overwrite):
    envs = {}
    args = {}

    if type(params_overwrite) != 'dict' or len(params_overwrite) == 0:
        return envs, args

    # Flat mapping: (field name in params) -> env var name
    flat_env_map = {
        'node_options': 'NODE_OPTIONS',
        'block_batch_size': 'BATCH_SIZE',
        'chain_id': 'CHAIN_ID',
        'endpoint': 'ENDPOINT',
        'start_block': 'START_BLOCK',
        'page_limit': 'POCKETDEX_DB_PAGE_LIMIT',
        'db_batch_size': 'POCKETDEX_DB_BATCH_SIZE',
        'db_bulk_concurrency': 'POCKETDEX_DB_BULK_WRITE_CONCURRENCY',
    }

    for key, env_var in flat_env_map.items():
        value = params_overwrite.get(key, '')
        if value != '':
            envs[env_var] = value

    # page_limit also affects args
    page_limit = params_overwrite.get('page_limit', '')
    if page_limit != '':
        args['--query-limit'] = page_limit

    # pg_pool nested mapping
    pg_pool = params_overwrite.get('pg_pool', {})
    if type(pg_pool) == 'dict' and len(pg_pool) > 0:
        for key in ['min', 'max', 'acquire', 'idle', 'evict']:
            value = pg_pool.get(key, '')
            if value != '':
                args['--pg-pool-%s' % key] = value

    return envs, args
