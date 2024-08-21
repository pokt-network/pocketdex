# Local Kubernetes Deployment <!-- omit in toc -->

- [Requirements](#requirements)
- [Deploy it](#deploy-it)
  - [1. \[Optional\] Set Up PostgreSQL](#1-optional-set-up-postgresql)
    - [2. Update Database Secrets](#2-update-database-secrets)
    - [3. Configure the Application](#3-configure-the-application)
    - [4. Deploy Indexer and Query Components](#4-deploy-indexer-and-query-components)
  - [Explore Locally](#explore-locally)
  - [Expose Publically](#expose-publically)
  - [Watch the Logs](#watch-the-logs)

## Requirements

1. **Kubernetes Cluster**; if you are already running Shannon in `Localnet`, you can work with it.
1. **Helm** & **PostgreSQL**; optional if you already have PostgreSQL

## Deploy it

**NOTE**: Before proceeding, ensure that the Kubernetes deployment has access to the Pocketdex image. You can build the image by following the instructions in the main [README](../README.md) file.

Then, do one of the following:

1. Load it into your Kubernetes cluster using `kind local docker-images <image:tag>`(if you're using it)
2. Push it to your preferred container registry

### 1. [Optional] Set Up PostgreSQL

**NOTE**: Skip this step if you already have a PostgreSQL instance running.

Add the Bitnami Helm repository:

```shell
helm repo add bitnami https://charts.bitnami.com/bitnami
```

Replace all the `CHANGEME` placeholders in `kubernetes/postgresql-values.yaml`.

Install PostgreSQL:

```shell
helm install postgresql bitnami/postgresql --version 15.5.23 -f kubernetes/postgresql-values.yaml
```

#### 2. Update Database Secrets

Replace all the `CHANGEME` placeholders in `kubernetes/db-secrets.yaml`.

Deploy them using:

```shell
kubectl apply -f kubernetes/db-secrets.yaml
```

#### 3. Configure the Application

Review/Edit and deploy the ConfigMap found in `kubernetes/configmap.yaml`:

```shell
kubectl apply -f kubernetes/configmap.yaml
```

#### 4. Deploy Indexer and Query Components

Create the indexer deployment and service:

```shell
kubectl apply -f kubernetes/indexer-deployment.yaml
```

Create the query deployment and service:

```shell
kubectl apply -f kubernetes/query-deployment.yaml
```

### Explore Locally

To explore the application locally, you can access the query playground using a simple `port-forward`:

```shell
kubectl port-forward svc/pocketdex-query --address 127.0.0.1 3000:3000
```

Navigate to `http://localhost:3000`, and you should see the GraphQL Playground.

### Expose Publically

If you need to permanently expose this to the world, you will need an Ingress controller.
Any Ingress controller should work, but here are a few popular ones:

- [HAProxy Ingress](https://artifacthub.io/packages/helm/haproxy-ingress/haproxy-ingress)
- [NGINX Ingress](https://artifacthub.io/packages/helm/nginx-ingress-chart/nginx-ingress)

Once the ingress controller is set up, you can use the example Ingress configuration located at
`kubernetes/ingress.yaml`.

**NOTE**: This file is just an example. You should review and edit it as needed before deploying it.
If you need TLS support, ensure your Ingress Controller is configured to handle it in front of the query service.

```shell
kubectl apply -f kubernetes/ingress.yaml
```

### Watch the Logs

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
