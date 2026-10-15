import { createDeployment } from '../src/auth/deployment.ts';
import { loadRuntime } from '../src/auth/bootstrap.ts';

/** Node 24 Web Standard entry point. Configuration is read lazily, never during build. */
export default createDeployment({ environment: () => process.env, load: loadRuntime });
