### Requirements

1. **Kubernetes Cluster**
  * If you are already running Shannon in `Localnet`, you can work with it.
2. **Helm** & **PostgreSQL** (optional if you already have PostgreSQL)

### Deploy it:

**NOTE:** Before proceeding, ensure that the Kubernetes deployment has access to the PocketDex image.
You can build the image by following the instructions in the README.md file.
Then, either load it into your Kubernetes cluster using `kind local docker-images <image:tag>`(if you're using it) or
push it to your preferred container registry.

#### 1. (Optional) Set Up PostgreSQL:

If you need to deploy PostgreSQL, add the Bitnami Helm repository and install PostgreSQL. Skip this step if you already
have a PostgreSQL instance running.

Add the Bitnami Helm repository:

```shell
helm repo add bitnami https://charts.bitnami.com/bitnami
```

Install PostgreSQL:
Replace all the `CHANGEME` placeholders in `kubernetes/postgresql-values.yaml` and then run:

```shell
helm install postgresql bitnami/postgresql --version 15.5.23 -f kubernetes/postgresql-values.yaml
```

#### 2. Update Database Secrets:

Replace `CHANGEME` placeholders in `kubernetes/db-secrets.yaml` and deploy them:

```shell
kubectl apply -f kubernetes/db-secrets.yaml
```

#### 3. Configure the Application:

Review/Edit and deploy the ConfigMap found in `kubernetes/configmap.yaml`:

```shell
kubectl apply -f kubernetes/configmap.yaml
```

#### 4. Deploy Indexer and Query Components:

Create the indexer deployment:

```shell
kubectl apply -f kubernetes/indexer-deployment.yaml
```

Create the query deployment:

```shell
kubectl apply -f kubernetes/query-deployment.yaml
```

#### 5. Create Services for Indexer and Query Components:

```shell
kubectl apply -f kubernetes/service.yaml
```

### Explore Locally:

To explore the application locally, you can access the query playground using a simple `port-forward`:

```shell
kubectl port-forward svc/pocketdex-query --address 127.0.0.1 3000:3000
```

Navigate to `http://localhost:3000`, and you should see the GraphQL Playground.

### Expose to the World:

If you need to permanently expose this to the world, you will need an Ingress Controller like:

* [HAProxy Ingress](https://artifacthub.io/packages/helm/haproxy-ingress/haproxy-ingress)
* [NGINX Ingress](https://artifacthub.io/packages/helm/nginx-ingress-chart/nginx-ingress)

Or any other ingress controller of your choice.
Once the ingress controller is set up, you can use the example Ingress configuration located at
`kubernetes/ingress.yaml`.
Please note, this file is just an example. You should review and edit it as needed before deploying it.
If you need TLS support, ensure your Ingress Controller is configured to handle it in front of the query service.

```shell
kubectl apply -f kubernetes/ingress.yaml
```

### Watch the Logs:

To watch the logs for both the Indexer and Query components:

```shell
kubectl logs -f -l app=pocketdex
```

To watch the logs for the Indexer component only:

```shell
kubectl logs -f -l app=pocketdex -l component=indexer
```

To watch the logs for the Query component only:

```shell
kubectl logs -f -l app=pocketdex -l component=query
```
