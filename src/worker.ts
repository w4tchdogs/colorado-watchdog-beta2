import { createApplication } from "./application.js";
import type { RuntimeEnvironment } from "./contracts/runtime.js";
import { createServices } from "./services/index.js";

const application = createApplication(createServices());

const worker = {
  fetch(request: Request, _environment: RuntimeEnvironment): Promise<Response> {
    return application.fetch(request);
  },
};

export default worker;
